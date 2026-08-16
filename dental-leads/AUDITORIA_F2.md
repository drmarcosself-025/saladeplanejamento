# Auditoria da Fase 2 — stale + reply_messages + outbox por bolha + envio sequencial seguro

> F2 implementada com os 11 ajustes obrigatórios da revisão incorporados desde
> o desenho (não como correção posterior). F3 (playbook, temperatura,
> objeções, push, Kanban) **não foi tocada**.

---

## A. Schema e fluxo de estados (o que foi mostrado antes de implementar)

### Migration `0005_bubble_sequencing.sql`

**Enums:**
- `send_status` ganha `SENDING` (entre `PENDING` e `SENT`/`FAILED`/`UNKNOWN`).
- `turn_outcome` ganha `SUPERSEDED`, `YIELDED`, `SEND_FAILED` — nenhum dos
  três é erro de automação.

**`messages`** (+2 colunas): `reserved_job_id bigint references jobs(id)`,
`reserved_worker_id text` — auditoria de quem reservou cada bolha.
`turn_id`/`bubble_sequence` já existiam desde a F1 e **passaram a ser o token
de fencing de verdade**: `claim_lead_jobs` gera um `turn_id` novo a cada
concessão de lease, e toda checagem crítica (`assert_turn_valid`,
`reserve_outbound_bubble`, `advance_bubble_to_sending`) agora compara o
`turn_id` que a chamada carrega contra o `turn_id` **atual** do job. Não foi
preciso um contador numérico separado — ele já mudava a cada lease, só
faltava comparar.

**Índices:** `UNIQUE (turn_id, bubble_sequence) WHERE direction='OUT' AND
sender_type='AI'` — nunca duas bolhas na mesma posição do mesmo turno.
`messages_sending_idx` para a rotina de reconciliação achar rápido o que
ficou preso.

**`automation_decisions`** (+1): `bubbles_planned` — só conveniência de
consulta; **as linhas de `messages` continuam sendo a fonte de verdade** de
quais bolhas saíram (item 11 da revisão).

### RPCs novas

| RPC | Papel |
|---|---|
| `advance_bubble_to_sending` | O portão atômico imediatamente antes do POST. Revalida tudo (lease, `turn_id`, takeover, automação, revisão, conjunto de mensagens) e, se válido, `PENDING → SENDING`; se não, cancela ali mesmo (`PENDING → CANCELLED`). |
| `reconcile_stuck_sending_bubbles` | Cobre o crash entre "Evolution aceitou" e "gravamos o resultado". Bolha em `SENDING` cujo job reservante não está mais `RUNNING` com o **mesmo `turn_id`** e lease viva vira `UNKNOWN` — nunca `PENDING`, nunca reenviada. |
| `yield_turn` | Devolução por orçamento de parede. Só o dono do lease cede; não gasta tentativa; não mexe em `needs_human`. |
| `cancel_reserved_bubble` | Cancelamento explícito e idempotente de uma reserva `PENDING`, com fencing por job+worker+`turn_id`. |

### Fluxo de estado de uma bolha (implementado exatamente como desenhado)

```
reserve_outbound_bubble()          advance_bubble_to_sending()        sendText()
  (atômico: checa+grava)             (revalida tudo de novo)
        │                                    │
(nada) ─reservada─▶ PENDING ──inválido──▶ CANCELLED (nunca chamou a Evolution)
        │                                    │ válido
        │                                    ▼
        │                              SENDING (gravado ANTES do POST)
        │                              ┌───────┼────────┐
        │                            2xx      4xx    timeout/5xx/crash
        │                              │        │          │
        │                              ▼        ▼          ▼
        │                            SENT   FAILED*     UNKNOWN
        │                                                   ▲
        │                                    reconcile_stuck_sending_bubbles()
        │                                    (worker morreu com a bolha em SENDING)
   recusada (lease/turn_id/stale/takeover)
        │
        ▼
  bolha nem chega a existir
```
`*` `FAILED` se divide em `PERMANENT_FAILURE` (4xx exceto 429 — vira caso
humano na hora, sem gastar tentativa) e `RETRYABLE_FAILURE` (429 — a própria
Evolution pedindo para esperar; lança exceção e usa o backoff que o job já
tem).

**`PARTIAL_STALE`**: batch marcado consumido só depois de pelo menos 1 bolha
`SENT`; as bolhas restantes de `reply_messages[]` nunca chegam a ser
reservadas (não existem como linha); nenhuma atualização semântica
(`stage`/`conversation_summary`/`treatment_interest`) é aplicada — o próximo
turno recalcula do histórico real.

---

## B. Confirmação item a item dos 11 ajustes obrigatórios

1. **`SUPERSEDED` em vez de `FAILED`** — implementado em `reclaim_expired_jobs`. `status=DONE`, `outcome=SUPERSEDED`, nunca toca `needs_human`. Testado nos casos 9b/9b2/9b3 (F1, atualizado) e 12a/12b/12c (F2).
2. **Reentrega não incrementa `conversation_revision`** — confirmado com teste isolado (caso 13 de `bubble_sequencing_test.sql`): mesmo `provider_message_id` reentregue 3x, revisão continua em 1.
3. **`turn_id`, `bubble_sequence`, `reserved_job_id`, `reserved_worker_id` em toda bolha `PENDING`** — gravados no `INSERT` de `reserve_outbound_bubble`. Testado no caso 1c.
4. **`assertTurnStillValid()` de novo antes do POST** — é exatamente o que `advance_bubble_to_sending` faz (revalida lease, `turn_id`, takeover, automação, revisão, conjunto), na MESMA transação que faz a transição de estado — mais forte do que uma checagem separada, porque fecha também a janela entre checar e escrever.
5. **Lease perdido entre reserva e envio → cancela, nunca envia** — testado no caso 4 (`bubble_sequencing_test.sql`): lease expira depois da reserva, `advance_bubble_to_sending` recusa e cancela a bolha.
6. **Reason codes estruturados e centralizados** — `TurnInvalidReason` (união fechada em `_shared/turn.ts`), `parseReason()` nunca confia cegamente em texto vindo do banco.
7. **`WORKER_WALL_BUDGET_MS` aplicado de verdade** — checkpoints antes da IA, antes de cada delay e antes de cada bolha. Estimativa proativa antes da 1ª bolha (evita começar uma sequência que não caberia). Depois da 1ª `SENT`, nunca mais cede — só completa ou fecha `PARTIAL_STALE`.
8. **`CANCELLED` só a partir de `PENDING`** — garantido pela cláusula `WHERE send_status = 'PENDING'` em `advance_bubble_to_sending` e `cancel_reserved_bubble`. Testado no caso 2 (bolha `SENT` não pode ser cancelada).
9. **`UNIQUE (turn_id, bubble_sequence)`** — testado em série (caso 3) e sob concorrência real (cenário 3 do script de shell, 10-12 processos simultâneos, sempre exatamente 1 sucesso).
10. **4xx não é tudo igual** — `classifyHttpFailure` em `evolution.ts`: 429 retryable, resto dos 4xx permanente, 5xx/timeout incerto. Testado em `tests/evolution_test.ts` e no harness Node.
11. **`bubbles_planned`/`bubbles_sent` são conveniência; `messages` é fonte de verdade** — nenhuma decisão do código lê os agregados; são só gravados para consulta.

---

## C. Testes — cada cenário pedido, com resultado

Executados de verdade contra Postgres 16 (migrations 0001→0005 em banco
limpo), não simulados.

| Cenário pedido | Onde | Resultado |
|---|---|---|
| Crash depois de `SENDING` e antes do fetch (resultado nunca soube) | `bubble_sequencing_test.sql` caso 7 | PASS — com lease viva, reconcile não mexe (7a); lease morre, bolha vira `UNKNOWN` e lead vira `needs_human` (7b-7d) |
| Crash depois do POST 2xx e antes de marcar `SENT` | caso 8 (lead isolado) | PASS — do ponto de vista do banco é o mesmo estado de "preso em SENDING"; reconciliação idêntica |
| Perda de lease entre reserva e envio | caso 4 | PASS — `advance_bubble_to_sending` recusa (`lease_perdido`) e cancela |
| Nova mensagem entre bolhas | caso 5 | PASS — bolha 1 SENT preservada; bolha 2 reservada e depois cancelada por `stale_revision_mismatch` quando a revalidação roda |
| Takeover entre bolhas | caso 6 | PASS — bolha 1 SENT preservada; reserva da bolha 2 recusada por `human_takeover` |
| Worker sem orçamento de parede antes da 1ª bolha | lógica em `sendBubbleSequence` (estimativa proativa) — verificado por leitura de código + unidade de `WallBudget` | PASS (unidade); não há um teste SQL dedicado porque a decisão é 100% TypeScript (não toca banco antes de decidir ceder) — ver seção D, risco 1 |
| Timeout | `tests/evolution_test.ts` (5xx/exceção → `UNKNOWN`) | PASS |
| 4xx permanente | `tests/evolution_test.ts` | PASS — 400/401/403/404/405/409/410/413/415/422 |
| 429 | `tests/evolution_test.ts` | PASS — retryable, distinto de permanente |
| Duas tentativas concorrentes da mesma sequência | `concurrency_test.sh` cenário 3 — 10 a 12 processos OS reais, mesma `(turn_id, bubble_sequence)`, conteúdo diferente cada um | PASS, repetido 3x — sempre exatamente 1 sucesso, resto recusado pelo índice único |
| Reconciliação de `UNKNOWN` via `fromMe` | caso 9 | PASS — eco tardio da Evolution traz a bolha de volta a `SENT` com o `provider_message_id` real, sem reenviar nada, e confirma que o eco **não** vira takeover |

**Casos adicionais cobertos** (não pedidos explicitamente, mas necessários para a integridade do desenho): `CANCELLED` só a partir de `PENDING` (caso 2) · `cancel_reserved_bubble` idempotente e com fencing (caso 10) · `yield_turn` só pelo dono, sem gastar tentativa (caso 11) · `SUPERSEDED` sem `needs_human` (caso 12) · regressão completa da F1 sob o schema novo (`turn_engine_test.sql`, 15 casos + fencing por `turn_id` acrescentado ao caso 7).

**Total: 24 casos em `bubble_sequencing_test.sql` (~35 sub-asserções) + 15 casos de regressão F1 + 3 cenários de concorrência real + suíte de `evolution.ts` + suíte de política/funil/normalização em TS puro. Todos PASS.**

### Dois bugs pegos pelos próprios testes durante a implementação

1. **Dedupe por hash bloqueava indefinidamente uma bolha que nunca foi enviada.** A primeira versão do dedupe em `reserve_outbound_bubble` considerava duplicata qualquer status anterior (inclusive `PENDING`/`SENDING` de um worker morto). Um retry legítimo com o mesmo texto ficaria preso para sempre. Corrigido: só `send_status = 'SENT'` conta como duplicata real.
2. **Teste do próprio dedupe ficou inconsistente com a correção acima.** O teste de regressão F1 esperava `'duplicado'` sem marcar a bolha anterior como `SENT` — com a correção do item 1, isso passou a tentar inserir na mesma posição de sequência e bateu no índice único novo. Corrigido no teste (marca `SENT` antes de testar dedupe; usa sequência própria).

---

## D. Riscos residuais (não eliminados)

1. **A estimativa proativa de orçamento antes da 1ª bolha é só uma estimativa.** `bubbleSendMarginMs` (5s por bolha, configurável) é um chute conservador, não uma medição real do tempo de POST. Se a Evolution estiver anormalmente lenta, o worker pode ainda assim começar uma sequência que não termina a tempo — nesse caso, a checagem reativa (`wallBudget.exceeded()` a cada iteração) segura o dano: sem nenhuma bolha enviada, cede limpo; com alguma já enviada, fecha `PARTIAL_STALE` em vez de travar.
2. **A janela entre `advance_bubble_to_sending` retornar `advanced:true` e o `POST` de fato sair** continua existindo (mesma natureza do risco 1 documentado na auditoria de F1) — é o preço de não fazer chamada de rede dentro de uma transação de banco. Mitigado por ser a última instrução antes do `fetch`.
3. **`reconcile_stuck_sending_bubbles` só age quando o lease genuinamente expira** (até `JOB_LEASE_SECONDS`, 120s por padrão). Uma bolha presa em `SENDING` fica "no limbo" por até esse tempo antes de virar `UNKNOWN` e notificar. Aceito — é o mesmo tipo de latência que `reclaim_expired_jobs` já tinha desde a F1.
4. **Testes de concorrência rodam neste container (Postgres local), não contra a topologia real do Supabase** (pooler, PostgREST, latência de rede real entre Edge Function e banco) — mesma ressalva já registrada na auditoria de F1.
5. **`PERMANENT_FAILURE` marca o lead como `needs_human` e encerra o turno, mas não distingue "número de telefone inválido de vez" de "erro de configuração temporário do lado da clínica"** — ambos exigem revisão humana hoje, o que é seguro, mas pode gerar mais trabalho manual do que o estritamente necessário. Não é um bug, é uma escolha deliberada de errar para o lado seguro; refinar isso é trabalho de F3 (playbook), não desta fase.

---

## E. Arquivos alterados nesta fase

```
supabase/migrations/0005_bubble_sequencing.sql   (novo)
supabase/functions/_shared/turn.ts               (alterado — WallBudget, advanceBubbleToSending, yieldTurn, reconcileStuckSendingBubbles, TurnInvalidReason)
supabase/functions/_shared/ai.ts                 (alterado — reply_messages[] no lugar de reply)
supabase/functions/_shared/policy.ts             (alterado — evaluatePostPolicy sobre o conjunto de bolhas)
supabase/functions/_shared/evolution.ts          (alterado — classifyHttpFailure, SendStatus de 4 valores)
supabase/functions/_shared/config.ts             (alterado — BUBBLE_SEND_MARGIN_MS)
supabase/functions/lead-worker/index.ts          (reescrito — sendBubbleSequence, checkpoints de orçamento)
tests/db/bubble_sequencing_test.sql              (novo — 24 casos)
tests/db/turn_engine_test.sql                    (atualizado — fencing por turn_id, SUPERSEDED, dedupe por SENT)
tests/db/concurrency_test.sh                     (+1 cenário — sequência sob concorrência real)
tests/evolution_test.ts                          (novo)
tests/policy_test.ts                             (atualizado — replyMessages[])
```

Não alterados nesta fase: `_shared/normalize.ts`, `_shared/funnel.ts`, `_shared/http.ts`, `wa-webhook/index.ts`, `web/*` — nada de playbook, temperatura, objeção, push, PWA ou Kanban, conforme pedido.

---

## F. Próxima fase

F3 (playbook, temperatura, objeção, política contextual, links por chave
autorizada, horário) segue como desenho em `ARQUITETURA-V2.md`, **não
implementada**. Aguardando aprovação antes de começar.
