# Auditoria da Fase 1 — motor de turno

> Rodada antes de iniciar F2, conforme pedido. Corrige dois gaps reais
> encontrados (revisão da conversa e fencing no momento da escrita) via
> `0004_revision_and_fencing.sql`. F2 não foi tocada.

---

## A. Implementado

**Migrations:**
- `0003_turn_engine.sql` — motor de turno original (cronologia, debounce,
  lock por lead, batch, outbox por bolha, `assert_turn_valid`, `close_turn`).
- `0004_revision_and_fencing.sql` — correção dos dois gaps desta auditoria:
  `conversation_revision`, `consumed_at`/`consumed_by_turn_id` (substituindo
  `processed`), RPC `reserve_outbound_bubble`.

**Campos novos:**
- `leads`: `last_inbound_at`, `last_outbound_at`, `conversation_revision bigint not null default 0`.
- `messages`: `provider_timestamp`, `received_at`, `content_hash`, `reply_to_provider_id`, `links`, `send_status`, `turn_id`, `bubble_sequence`, `consumed_at`, `consumed_by_turn_id`. **Removido:** `processed`.
- `automation_decisions`: `turn_id`, `batch_message_ids uuid[]`, `outcome`, `bubbles_sent`, `input_revision`.
- `jobs`: `debounce_started_at`, `run_after`, `locked_by`, `lease_expires_at`, `turn_id`, `outcome`. **Removido:** `message_id` (deixou de ser dono de mensagem).

**Enums novos:** `send_status` (PENDING/SENT/UNKNOWN/FAILED/CANCELLED), `turn_outcome` (COMPLETED/STALE_BEFORE_SEND/PARTIAL_STALE/HUMAN_TAKEOVER/SEND_UNKNOWN/NO_REPLY/FAILED).

**Índices:**
- `messages_chrono_idx (lead_id, received_at, id)` — ordenação cronológica estável.
- `messages_pending_in_idx (lead_id, received_at) where direction='IN' and consumed_at is null` — o batch.
- `messages_turn_idx`, `messages_consumed_by_turn_idx`.
- `jobs_one_pending_per_lead` **unique** `(lead_id) where status='PENDING'` — a base do debounce por lead.
- `jobs_ready_idx (run_after) where status='PENDING'`, `jobs_running_lease_idx`.

**RPCs (todas `security definer`, revogadas de `anon`/`authenticated`):**
`ingest_inbound_message` (reescrita — debounce + revisão), `ingest_outbound_event` (takeover, agora sem `processed`), `claim_lead_jobs` (lock por lead), `renew_lease` (heartbeat), `fetch_batch` (batch + revisão na mesma consulta), `assert_turn_valid` (checkpoint de leitura, com revisão), `reserve_outbound_bubble` (**novo** — checagem + escrita atômica), `close_turn` (fecha turno, `consumed_at`), `reclaim_expired_jobs`, `get_turn_stats`.

**Código (`supabase/functions/`):**
- `_shared/turn.ts` — `claimTurns`, `renewLease`, `fetchBatch` (devolve `{messages, revision}`), `assertTurnStillValid`, `reserveOutboundBubble` (novo), `closeTurn`, `reclaimExpiredJobs`, `outcomeForInvalidTurn`, `naturalDelayMs`.
- `lead-worker/index.ts` — reescrito como orquestrador de turno; `deliver()` usa `reserveOutboundBubble` em vez de checar-e-depois-gravar em duas chamadas.
- `wa-webhook/index.ts` — sem mudança nesta auditoria (já enfileirava por lead desde F1; a RPC que ele chama mudou por dentro, a chamada em si não).
- `_shared/policy.ts`, `_shared/ratelimit.ts`, `_shared/ai.ts`, `_shared/funnel.ts`, `_shared/evolution.ts`, `_shared/config.ts` — sem mudança nesta auditoria (fora de escopo: item 8 pedia para não tocar IA/playbook).

**Testes:**
- `tests/db/turn_engine_test.sql` — 15 casos, script transacional único (`begin`/`rollback`).
- `tests/db/concurrency_test.sh` — 2 cenários com processos OS reais concorrendo.
- `tests/turn_test.ts`, `tests/policy_test.ts`, `tests/normalize_test.ts` — lógica pura, sem Postgres.

---

## B. Testes (PASS/FAIL)

Todos executados de verdade nesta sessão, contra Postgres 16 real (não simulação/mock), com as migrations 0001 → 0003 → 0004 aplicadas em banco limpo.

### `tests/db/turn_engine_test.sql` (15 casos)

| # | Caso | Resultado |
|---|---|---|
| 1 | 1ª mensagem cria lead, mensagem, job PENDING, revisão=1 | PASS |
| 2 | 2ª mensagem da rajada: mesmo job, `run_after` empurrado, `debounce_started_at` preservado, revisão=2 | PASS |
| 3 | Teto de 30s contado desde o início da rajada (não reiniciado) | PASS |
| 4 | Reentrega (`provider_message_id` repetido): duplicata, revisão **não** incrementa | PASS |
| 5 | Claim respeita `run_after`; lock por lead (2º worker não pega o mesmo lead) | PASS |
| 6 | Batch em ordem cronológica exata; revisão devolvida bate com o lead | PASS |
| 7a–g | `assert_turn_valid`: turno íntegro válido · lease de outro worker recusado · **revisão desatualizada recusa mesmo com ids "completos"** · conjunto incompleto recusa (defesa em profundidade) · takeover interrompe · `needs_human` bloqueia AI_REPLY · handoff passa em HUMAN_REQUIRED | PASS (7 sub-casos) |
| 8a–e | `reserve_outbound_bubble`: worker sem lease recusado · revisão velha recusada · dono com tudo certo reserva · bolha idêntica recente = duplicata · batch incompleto recusa (defesa em profundidade) | PASS (5 sub-casos) |
| 9a–f | **Cenário RUNNING+PENDING pedido explicitamente**: Job A RUNNING com lease vencido, mensagem nova cria Job B PENDING, `reclaim_expired_jobs()` NÃO reabre A (fecha como FAILED), B continua intacto, nunca >1 PENDING por lead, worker antigo de A tenta `reserve_outbound_bubble` e é recusado (`lease_perdido`), B é claimado e processado normalmente | PASS (6 sub-casos) |
| 10 | `close_turn` sem envio: mensagem NÃO marcada consumida, reaparece no próximo `fetch_batch` | PASS |
| 11a–c | `close_turn` com envio: `consumed_at` gravado, `consumed_by_turn_id` = turno correto, mensagem some do batch | PASS (3 sub-casos) |
| 12a–b | `FAILED`: retry com backoff · tentativas esgotadas → `FAILED` + lead vira `HUMAN_REQUIRED` | PASS (2 sub-casos) |
| 13a–b | Lease expirado sem concorrente volta a `PENDING`; `renew_lease` só funciona para o dono | PASS (2 sub-casos) |
| 14 | Dois leads diferentes claimados juntos (paralelo) | PASS |
| 15a–b | Takeover cancela turno pendente; eco da própria bolha NÃO vira takeover | PASS (2 sub-casos) |

**Resultado: `NOTICE: TODOS OS CASOS PASSARAM` — 15/15 PASS (≈40 sub-asserções).**

### `tests/db/concurrency_test.sh` (processos OS reais, não script serial)

| Cenário | Execuções | Resultado |
|---|---|---|
| 8–12 workers disputando 2 leads simultâneos (`claim_lead_jobs`) | 2 rodadas | PASS — sempre exatamente 2 turnos claimados, nunca 2 no mesmo lead |
| 10–12 processos chamando `reserve_outbound_bubble` para o **mesmo** job/conteúdo ao mesmo tempo | 4 rodadas (10, 10, 12, 12 processos) | PASS — sempre exatamente 1 reserva bem-sucedida, 1 única linha gravada |

Este segundo cenário é o que prova o fencing sob **concorrência real** (processos OS de verdade, não chamadas em sequência dentro de uma transação): o `FOR UPDATE` na linha do job serializou corretamente em toda execução.

### Lógica pura (TypeScript, sem Postgres)

`_shared/normalize.ts`, `_shared/policy.ts`, `_shared/ratelimit.ts`, `_shared/funnel.ts`, `_shared/turn.ts` (funções puras) — checagem de sintaxe + suíte de asserções equivalente aos arquivos `tests/*.ts` rodada via `node --experimental-strip-types` (sem Deno disponível neste ambiente). **PASS** em todos os casos, incluindo regressão da F1 original (LID, wrappers, política verde/amarelo/vermelho, rate limit por turno, funil).

### O que NÃO foi testado (limite honesto)

Nada foi executado contra Supabase hospedado, Evolution API real ou provedor de IA real — dependem do seu ambiente. `deno test` não rodou literalmente (sem Deno no container); a lógica foi verificada via Node com o mesmo código-fonte, o que cobre a lógica mas não o runtime Deno específico (ex.: `Deno.serve`, `EdgeRuntime.waitUntil`).

---

## C. Problemas encontrados (todos corrigidos)

1. **Sem `conversation_revision`/`input_revision`** — a F1 original só tinha o `NOT EXISTS` por conjunto de ids. Funcionalmente correto, mas não era o mecanismo pedido nem o mais barato. **Corrigido**: contador monotônico + `fetch_batch` lendo revisão e mensagens na mesma consulta (para não descartar por engano um batch completo — ver seção G).

2. **Fencing incompleto (TOCTOU real)** — `assert_turn_valid` confirmava posse do lease numa chamada; o `INSERT` da bolha acontecia em OUTRA chamada, logo depois. Entre as duas existia uma janela genuína em que um worker que tivesse acabado de perder o lease ainda poderia gravar. **Corrigido**: `reserve_outbound_bubble` faz checagem + escrita numa transação só, com `FOR UPDATE` na linha do job. Verificado sob concorrência real (seção B).

3. **`processed` boolean ambíguo** — pedido explícito de revisão. **Corrigido**: removido (não apenas deprecado) e substituído por `consumed_at`/`consumed_by_turn_id` em todas as 5 funções que o referenciavam (incluindo `ingest_outbound_event`, que eu tinha esquecido na primeira passagem da correção — pego pelo próprio teste, que falhou com `column "processed" does not exist` até eu caçar a última referência).

4. **Bug introduzido durante a própria correção**: a primeira versão de `reserve_outbound_bubble` checava "existe QUALQUER mensagem IN não consumida" sem excluir o `batch_ids` conhecido — o que bloquearia toda reserva legítima (o batch inteiro sempre tem mensagens não consumidas até o `close_turn`). Pego pelo teste 8c falhando com `stale_nova_mensagem` num cenário que deveria ter sucesso. Corrigido adicionando `p_batch_ids` como parâmetro, espelhando a lógica de `assert_turn_valid`.

5. **Bug no script de concorrência**: comparação `[ "$val" = "t" ]` para o resultado de `->>'reserved'`, que na verdade devolve o texto JSON `"true"`/`"false"`, não o boolean nativo do Postgres (`t`/`f`). O teste reportava "0 reservas bem-sucedidas" mesmo com o banco correto (1 linha gravada) — falso negativo no diagnóstico, não no comportamento. Corrigido.

*(Os dois defeitos de cronologia da F1 original — `now()` vs `clock_timestamp()`, e `next_attempt_at` nascendo no futuro — já estavam documentados e corrigidos antes desta auditoria; listados aqui só para registro, não são novidade.)*

---

## D. Riscos residuais (não eliminados tecnicamente)

1. **A janela final entre `reserve_outbound_bubble` retornar `reserved:true` e o `POST` de fato chegar na Evolution.** Isso nunca fecha sem transação distribuída com um sistema externo — é matematicamente impossível de eliminar, só de encurtar. Mitigação: a reserva acontece o mais perto possível do envio, e qualquer resultado incerto (`UNKNOWN`) nunca é reenviado automaticamente.
2. **`reclaim_expired_jobs` e um `ingest_inbound_message` concorrente correndo no mesmo instante** — tratado com `exception when unique_violation then return 0`, mas depende do índice parcial único fazer seu trabalho; nunca testado com um adversário sintético de verdade (só inferido do comportamento do Postgres). Risco: teórico, não observado.
3. **`get_turn_stats`/rate limit por turno ainda lê `automation_decisions`, não os campos novos de revisão** — não é uma falha, mas rate limit e motor de turno são checagens independentes; nenhuma auditoria cruzada entre os dois foi feita nesta rodada (fora do escopo pedido).
4. **Testes de concorrência rodam neste container (Postgres local), não contra a topologia real do Supabase** (pooler, PostgREST, latência de rede entre Edge Function e banco). O `FOR UPDATE` é garantia do Postgres em si, então deve se comportar igual — mas "deve" não é "foi observado em produção".
5. **`WORKER_WALL_BUDGET_MS` existe em config mas não é aplicado em nenhum lugar do código ainda** — o worker não aborta um lote no meio se estourar o orçamento de parede. Achado durante a auditoria, fora do escopo dos itens pedidos (não é sobre debounce/lock/revisão/fencing), registrado aqui para não esquecer.

---

## E. Arquivos alterados nesta auditoria

```
supabase/migrations/0004_revision_and_fencing.sql   (novo, 588 linhas)
supabase/functions/_shared/turn.ts                  (alterado)
supabase/functions/lead-worker/index.ts             (alterado)
tests/db/turn_engine_test.sql                        (reescrito, 15 casos)
tests/db/concurrency_test.sh                          (alterado, +2º cenário)
ARQUITETURA-V2.md                                     (seção de status atualizada)
AUDITORIA_F1.md                                       (este arquivo, novo)
```

Não alterados nesta auditoria (conforme item 8): `_shared/ai.ts`, `_shared/policy.ts`, `_shared/funnel.ts`, `_shared/ratelimit.ts`, `wa-webhook/index.ts`, `web/*`.

---

## F. Migration — resumo

`0004_revision_and_fencing.sql`, aplicada depois de `0001_init.sql` e `0003_turn_engine.sql`:

- `leads.conversation_revision bigint not null default 0` — incrementado atomicamente em toda mensagem IN genuína (não em reentrega).
- `messages.consumed_at` / `messages.consumed_by_turn_id` substituem `processed` (removida).
- Nova RPC `reserve_outbound_bubble` — o portão atômico: lease + revisão + takeover + duplicidade + `INSERT`, tudo numa função com `FOR UPDATE` na linha do job.
- `fetch_batch`, `assert_turn_valid`, `close_turn`, `ingest_inbound_message`, `ingest_outbound_event` recriadas para usar os campos novos.
- Sem downtime necessário: projeto ainda não está em produção, migration roda direto.

---

## G. Fluxo final da F1 (auditado) — do webhook ao batch pronto para IA

```
1.  Evolution → wa-webhook (secret validado)
2.  normalizeWhatsAppEvent() → identidade (LID nunca vira telefone), texto, tipo
3.  ingest_inbound_message() [TRANSAÇÃO]
      upsert lead
      insert message (ON CONFLICT provider_message_id DO NOTHING)
      se duplicata → não mexe em nada, retorna
      se genuína → conversation_revision += 1
      upsert job: run_after = min(agora+debounce, debounce_started_at+teto)
                  (debounce_started_at NUNCA é reescrito)
4.  wa-webhook devolve 200 só depois da transação fechar
5.  wa-webhook dispara lead-worker sem esperar (fire-and-forget)
────────────────────────────────────────────────────────────────
6.  lead-worker (acordado pelo webhook) dorme a janela de debounce
7.  reclaim_expired_jobs() — devolve turno de worker morto;
    se já existe PENDING mais novo para o mesmo lead, fecha o antigo como
    FAILED em vez de reabrir (cenário do item 2 da revisão)
8.  claim_lead_jobs():
      só turnos com run_after <= now()
      NUNCA claima lead que já tem outro RUNNING com lease vivo
      FOR UPDATE SKIP LOCKED entre workers concorrentes
9.  fetch_batch(lead_id):
      todas as mensagens IN com consumed_at IS NULL
      ordem: (received_at, id) — nunca ordem de SELECT
      revisão da conversa lida NA MESMA consulta (consistência garantida)
10. batch pronto: N mensagens em ordem + revisão capturada
    → é este o ponto de entrada da IA (Fase 2/3, fora desta auditoria)
```

Da mensagem 6 em diante (assert_turn_valid / reserve_outbound_bubble / stale
entre bolhas) pertence à F2, ainda não implementada.

---

## H. Próxima fase — SOMENTE o plano (não implementado)

**F2 — stale + `reply_messages[]` + outbox por bolha + envio sequencial seguro**, incorporando o que a F1 já entrega:

1. Depois da chamada de IA, checar `assertTurnStillValid` (leitura barata) antes de gastar rate limit.
2. Para CADA bolha de `reply_messages[]`, na ordem:
   a. delay natural entre bolhas;
   b. `reserveOutboundBubble()` — a checagem-e-escrita atômica já pronta desta auditoria, reaproveitada tal como está;
   c. se recusada por `stale_revision_mismatch`/`stale_nova_mensagem`/`human_takeover` → para a sequência ali, sem mandar as bolhas seguintes;
   d. se `duplicado` → pula silenciosamente (idempotência, worker zumbi);
   e. envia via Evolution, carimba `send_status`.
3. Se pelo menos 1 bolha saiu e as demais foram canceladas → `outcome = PARTIAL_STALE`, registrando exatamente quais `bubble_sequence` saíram e quais foram `CANCELLED`. Resumo/etapa/interesse da decisão **não** são aplicados quando o turno não completou — o próximo turno recalcula do histórico real, não da sugestão obsoleta.
4. Se nenhuma bolha saiu → o `close_turn` já existente cuida de devolver o batch (comportamento já testado nesta auditoria, casos 10/13).
5. Rate limit por turno (não por bolha) — já é a unidade usada por `get_turn_stats`; F2 só precisa confirmar que o gate roda uma vez por turno, antes da primeira bolha, não uma vez por bolha.

Nenhum destes 5 pontos foi codificado. Aguardando aprovação para começar.
