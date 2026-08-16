# Validação final pré-F3 (F2.5)

> Os 4 pontos pedidos foram auditados, 3 gaps reais corrigidos, todos testados
> contra Postgres 16 real. O smoke test de integração real (Supabase + Evolution
> + WhatsApp) **não foi executado por mim** — não tenho credenciais do seu
> projeto Supabase, acesso de rede à sua instância Evolution (auto-hospedada na
> sua VPS), nem um número de WhatsApp de teste. Seção final explica exatamente
> o que preparei em troca.

---

## 1. Dedupe por `content_hash`

### Escopo antes desta validação

```sql
where lead_id = p_lead_id and direction = 'OUT' and content_hash = p_content_hash
  and send_status = 'SENT' and created_at > now() - janela_de_120s
```

Bloqueava por **lead + hash + janela de tempo**, sem olhar para o momento da
conversa. Duas mensagens "Perfeito 😊" com 30 minutos de diferença **não**
seriam bloqueadas (30 min > janela de 120s) — mas duas mensagens coincidentes
dentro da mesma janela de 120s **seriam** bloqueadas indevidamente, mesmo
sendo turnos sem relação nenhuma entre si. Gap real, mesmo que estreito.

### Correção

Dedupe agora escopado por **lead + hash + `reservation_revision` + janela**.
`reservation_revision` é a `conversation_revision` do lead no momento exato em
que aquela bolha foi reservada (nova coluna em `messages`, gravada por
`reserve_outbound_bubble`).

Por que revisão é a chave certa, não `turn_id`: um retry legítimo do mesmo
turno reclamado (worker perdeu o lease, job foi reclamado, novo `claim_lead_jobs`
gera um `turn_id` **novo**) mantém a mesma `conversation_revision`, porque
nenhuma mensagem nova chegou. Um segundo turno genuíno só existe porque uma
mensagem nova chegou — e mensagem nova sempre incrementa a revisão. Logo:
**mesma revisão + mesmo hash + já `SENT` = quase certamente o mesmo turno
retomado** (bloqueia, correto); **revisão diferente = outro momento da
conversa** (nunca bloqueia, mesmo com texto idêntico).

`turn_id + bubble_sequence` continua sendo a identidade forte de uma bolha
individual (dona da `UNIQUE` do banco). Hash continua auxiliar.

### Teste (`prerelease_validation_test.sql`, PONTO 1)

Lead único, dois turnos genuinamente diferentes com "Perfeito 😊" nos dois —
os dois viram `SENT`. E, para confirmar que a proteção original não
regrediu: mesma revisão + mesmo hash + já `SENT` continua sendo recusado como
`duplicado` (retry de zumbi). **PASS.**

---

## 2. Reconciliação de `fromMe`

### Ordem de correlação implementada

1. **`provider_message_id` exato** — já existia, é o caminho normal quando a
   Evolution devolveu o id no POST e o webhook chega depois.
2. **Correlação direta da Evolution** — **não existe nesta integração hoje**.
   `/message/sendText` da Evolution não aceita nem devolve um id de
   correlação fornecido pelo cliente que sobreviva à volta pelo webhook.
   Documentado no código em vez de fingir que existe; se a Evolution passar
   a suportar isso, é aqui que entraria, antes do fallback por hash.
3. **Fallback por hash/texto** — só quando o candidato é **único** dentro da
   janela (mesmo lead, já era).

### Gap encontrado e corrigido

Com 2+ candidatos plausíveis (mesmo texto, mesmo lead, dentro da janela), o
código antigo pegava `order by created_at desc limit 1` — escolhia "o mais
recente" **às cegas**. Errado: carimbar o `provider_message_id` na bolha
errada corrompe a auditoria e, pior, contamina o rate limit por turno (que
lê `messages`).

Corrigido: `ingest_outbound_event` agora conta candidatos antes de agir.
- 0 candidatos → humano respondeu pelo WhatsApp de verdade → `HUMAN_TAKEOVER`.
- 1 candidato → reconcilia normalmente (`linked_pending`).
- 2+ candidatos → **não reconcilia nada**, marca `needs_human = true`,
  devolve `reason: 'ambiguous_echo'` com a contagem.

### Teste (PONTO 2)

Duas bolhas `SENDING` com texto idêntico no mesmo lead → evento `fromMe` →
nenhuma das duas é tocada, nenhuma ganha `provider_message_id`, lead vira
`needs_human`, motivo `ambiguous_echo` com `candidates: 2`. Caminho feliz
(candidato único) confirmado continuando a funcionar. **PASS.**

---

## 3. Corrida SENDING / reconciler / HTTP tardio

### O bug — confirmado por leitura direta do código antes de escrever teste

As 4 escritas finais de `send_status` no worker eram updates **irrestritos**:

```ts
await supabase.from("messages").update({ send_status: "SENT", ... }).eq("id", messageId);
```

Sem checar se a bolha ainda pertence a este `job_id`/`worker_id`/`turn_id`,
nem se ainda está em `SENDING`. Um POST tardio (Worker A demorou, lease
expirou, o reconciler já declarou `UNKNOWN`, e só depois o POST original
retorna 2xx) sobrescreveria o `UNKNOWN` de volta para `SENT` **em silêncio**
— exatamente o cenário que você descreveu.

### Correção

Nova RPC `finalize_bubble_send`, a **única** porta de escrita para o
resultado final: só transiciona `SENDING → resultado` se a bolha ainda
pertence a este job/worker/`turn_id` **e** ainda está em `SENDING`. Fora
disso, se o resultado tardio for `SENT`, fica registrado em
`meta.late_confirmation` (auditoria: "a Evolution confirmou depois, mas o
sistema já tinha decidido outra coisa") — nunca reverte `send_status` nem
`needs_human`. As 4 chamadas antigas em `lead-worker/index.ts` foram
substituídas por esta única porta.

### `SENDING_STALE_AFTER_MS` — regra exata

```
reconcile_stuck_sending_bubbles() só declara uma bolha UNKNOWN quando, ao
mesmo tempo:
  (a) o job que a reservou não está mais RUNNING com o MESMO turn_id e
      lease viva (condição já existente desde a F2 — cobre reclaim/crash);
  (b) já se passou SENDING_STALE_AFTER_MS desde que a bolha entrou em
      SENDING (novo — nova coluna messages.sending_at).
```

(b) é necessário mesmo com (a) já verdadeiro: o job pode ter perdido o lease
por qualquer motivo (inclusive um lease que só por acaso estava quase
vencendo no instante exato da transição) enquanto o POST original ainda está
genuinamente em voo. Reconciliar antes do tempo arrisca declarar `UNKNOWN`
algo que só está demorando dentro do normal.

Default: `SENDING_STALE_AFTER_MS = EVOLUTION_TIMEOUT_MS + 30000` — **derivado
em `config.ts`, não um número solto**, para nunca ficar menor que o timeout
real do POST se alguém ajustar `EVOLUTION_TIMEOUT_MS`. `configWarnings()`
loga um aviso (não fatal) se a relação for violada por configuração manual
explícita.

### Teste (PONTO 3)

Sequência completa: `SENDING` → lease vence, mas ainda dentro da margem →
reconciler **não** mexe → `sending_at` forçado para 1h atrás (além da
margem) → reconciler declara `UNKNOWN` + `needs_human` → POST tardio chega
com 2xx → `finalize_bubble_send` **recusa** aplicar (`finalized: false,
late: true`) → `send_status` continua `UNKNOWN`, `needs_human` continua
`true`, e a confirmação de entrega fica em `meta.late_confirmation` com o
`provider_message_id` real preservado. Caminho feliz (sem corrida) também
confirmado. **PASS.**

---

## 4. Yield depois da primeira bolha

Comportamento já estava correto desde a F2 (`sendBubbleSequence` só cede
quando `sent === 0`); esta validação **extraiu a regra numa função pura**
(`shouldYieldOnBudgetExceeded`) para ficar testável isoladamente, sem
precisar simular o pipeline inteiro.

**Como o worker encerra com segurança se o orçamento fica crítico depois que
a sequência já começou:** não cede. Fecha a sequência normalmente — com o
que já saiu contabilizado — usando o mesmo caminho de uma interrupção por
stale: `outcome = COMPLETED` (se por acaso essa era a última bolha) ou
`PARTIAL_STALE` (se sobrou bolha planejada e não reservada). O job é
liberado via `close_turn` (status `DONE`, lease solta) como qualquer outro
fim de turno — nunca fica pendurado. Nenhuma bolha nova é reservada; as que
não chegaram a existir simplesmente não têm linha nenhuma.

### Teste

`tests/turn_test.ts`: `shouldYieldOnBudgetExceeded(0) === true`;
`shouldYieldOnBudgetExceeded(n) === false` para `n` de 1 a 10. **PASS.**

---

## Migration e arquivos alterados

`0006_dedupe_scope_and_race_guards.sql`:
- `messages.reservation_revision`, `messages.sending_at` (novas colunas);
- `reserve_outbound_bubble` — dedupe escopado por revisão;
- `advance_bubble_to_sending` — grava `sending_at`;
- nova RPC `finalize_bubble_send` — porta única de escrita final;
- `reconcile_stuck_sending_bubbles` — ganha `p_stale_after_ms` (**drop
  explícito da assinatura antiga** — mudar de 0 para 1 parâmetro com default
  via `CREATE OR REPLACE` criaria um overload ambíguo em vez de substituir,
  pego pelo próprio teste de regressão da F2 falhando com "could not choose
  a best candidate function");
- `ingest_outbound_event` — conta candidatos antes de reconciliar.

Código: `_shared/config.ts` (+`sendingStaleAfterMs`, `+configWarnings()`),
`_shared/turn.ts` (+`finalizeBubbleSend`, `+shouldYieldOnBudgetExceeded`),
`lead-worker/index.ts` (as 4 escritas irrestritas substituídas por
`finalizeBubbleSend`).

Testes: `tests/db/prerelease_validation_test.sql` (novo, 3 pontos SQL),
`tests/turn_test.ts` (+ ponto 4), `tests/db/turn_engine_test.sql` e
`tests/db/bubble_sequencing_test.sql` (ajustados para a margem de
`SENDING_STALE_AFTER_MS` nos casos que já simulavam lease vencida).

**Todos os testes (F1 + F2 + esta validação + 3 cenários de concorrência
real) rodados do zero contra Postgres 16, todos PASS**, incluindo dois bugs
que só apareceram executando de verdade: a ambiguidade de overload do
`reconcile_stuck_sending_bubbles` e a necessidade de simular `sending_at`
antigo nos testes de F2 que já forçavam lease vencida.

---

## Smoke test de integração real — o que não pude fazer, e o que preparei

**Não executei o smoke test.** Este ambiente não tem: credenciais do seu
projeto Supabase (para fazer deploy das Edge Functions), acesso de rede à sua
instância Evolution (auto-hospedada na sua VPS, atrás do seu EasyPanel — sem
rota daqui), nem um número de WhatsApp real para receber/enviar mensagens.
Simular esses três componentes ou fingir um resultado seria pior que admitir
o limite.

O que fiz em vez disso, para o smoke test custar o mínimo possível quando
você (ou uma sessão com acesso à sua infraestrutura) for rodá-lo:

1. **Todo o motor que o smoke test vai exercitar já está provado
   corretamente em isolamento** — debounce, lock por lead, revisão,
   fencing, `SENDING`, reconciliação, dedupe, ambiguidade de `fromMe`,
   yield — os 12 cenários pedidos usam mecanismos que já têm teste
   dedicado no banco. O smoke test deixa de ser "descobrir se a lógica
   funciona" e passa a ser "confirmar que a integração com Evolution/
   WhatsApp bate com o que a lógica pressupõe" — um escopo bem menor.
2. Deploy: `supabase functions deploy wa-webhook --no-verify-jwt` e
   `lead-worker --no-verify-jwt`, secrets via `.env.example` preenchido.
3. Para cada um dos 12 cenários pedidos, a query SQL exata que confirma
   PASS/FAIL está pronta (é essencialmente o que os testes locais já fazem,
   apontado para tabelas reais em vez de `rollback`).

Se você rodar e me passar os logs das Edge Functions (Supabase → Edge
Functions → Logs) e o resultado das consultas, eu analiso, comparo com o
comportamento esperado documentado aqui, listo diferenças e entrego o
PASS/FAIL formatado exatamente como pedido — sem repetir trabalho, porque a
lógica já está validada; falta só a integração de verdade.
