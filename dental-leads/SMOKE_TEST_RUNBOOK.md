# Smoke test F2.5 — runbook de execução

> Para rodar contra Supabase Edge Functions reais + Evolution API real +
> WhatsApp de teste. Eu (Claude) não tenho acesso a nenhum dos três — este
> documento é o que falta para alguém com esse acesso executar e me devolver
> os resultados para eu analisar.

## Antes de começar

1. **Use um número de WhatsApp de teste, não o de produção** (pedido
   explícito). Se só existir o número de produção, pare aqui e providencie um
   de teste primeiro — nenhum cenário abaixo deveria ser tentado no número
   real da clínica.
2. Deploy: `supabase functions deploy wa-webhook --no-verify-jwt` e
   `supabase functions deploy lead-worker --no-verify-jwt`.
3. Confirme os secrets (`supabase secrets list`) — em especial
   `EVOLUTION_API_URL`, `EVOLUTION_INSTANCE`, `WEBHOOK_SECRET`,
   `WORKER_SECRET`, `AI_API_KEY`.
4. Aponte o webhook da instância de teste para `wa-webhook` (ver
   `docs/evolution-webhook.md` — **não mexa na instância de produção**).
5. Abra em paralelo: Supabase → Edge Functions → Logs (as duas functions) e
   um cliente SQL para as queries abaixo.

## Query de apoio (rode depois de cada cenário)

```sql
select m.id, m.direction, m.sender_type, m.text, m.send_status,
       m.turn_id, m.bubble_sequence, m.provider_message_id,
       m.received_at, m.created_at
  from public.messages m
  join public.leads l on l.id = m.lead_id
 where l.phone = '<numero-de-teste>'
 order by m.received_at;
```

```sql
select turn_id, action, outcome, bubbles_sent, bubbles_planned, reason, created_at
  from public.automation_decisions ad
  join public.leads l on l.id = ad.lead_id
 where l.phone = '<numero-de-teste>'
 order by created_at;
```

---

## Os 12 cenários

| # | Cenário | Como executar | PASS quando |
|---|---|---|---|
| 1 | Mensagem simples | Mande "Oi, queria saber sobre Invisalign" | Uma resposta chega em até ~10s; `messages` tem 1 IN + 1..3 OUT `SENT`; `automation_decisions.outcome = COMPLETED` |
| 2 | Rajada de 3–5 mensagens | Mande 4 mensagens em <5s cada | Uma única chamada de IA (confira nos logs do `lead-worker`: só 1 `ai_erro_chamada`/sucesso por rajada); UMA resposta coerente ao conjunto, não 4 respostas |
| 3 | Mensagem nova enquanto IA prepara resposta | Mande algo, e assim que enviar, mande outra coisa antes de qualquer resposta chegar | A primeira geração é descartada (log `descartada_pos_ia` ou `stale_before_send`); a resposta que chega responde ao conjunto completo |
| 4 | Mensagem nova entre bolha 1 e bolha 2 | Peça algo que gere 2+ bolhas (ex.: "me fala tudo sobre Invisalign, preço, e como agendar"); assim que a bolha 1 chegar no WhatsApp, mande mensagem nova | `outcome = PARTIAL_STALE`; bolha 1 `SENT`, bolha 2 nunca chega a existir como linha (ou `CANCELLED`, dependendo do ponto exato da corrida) |
| 5 | Resposta manual → HUMAN_TAKEOVER | Alguém responde pelo próprio celular da clínica | `leads.automation_status = 'HUMAN_TAKEOVER'`; a mensagem manual aparece em `messages` com `sender_type='HUMAN'`; nenhuma resposta automática depois disso |
| 6 | Mensagens iguais em turnos diferentes | Provoque a IA a responder algo curto genérico (ex. "Perfeito 😊") em dois momentos bem separados (>5 min, conversas desconectadas) | As duas viram `SENT`; nenhuma bloqueada como `duplicado` (ver PONTO 1 de `AUDITORIA_F2_5.md`) |
| 7 | Evento `fromMe` real | Consequência natural do cenário 5 — confirme que o evento chegou no `wa-webhook` (log `human_takeover`) | Presente nos logs, sem erro |
| 8 | Captura real do `provider_message_id` | Depois de qualquer envio automático (cenário 1) | `messages.provider_message_id` preenchido com o id real devolvido pela Evolution, não nulo |
| 9 | Timeout/UNKNOWN | Difícil simular com segurança sem derrubar a Evolution de propósito — **só tente se puder pausar a instância de teste momentaneamente** (não a de produção). Alternativa mais segura: reduza `EVOLUTION_TIMEOUT_MS` temporariamente para um valor muito baixo (ex. 100ms) só neste ambiente de teste, force um envio, restaure depois | `send_status = 'UNKNOWN'`; `needs_human = true`; nenhum reenvio automático depois |
| 10 | Reconciliação UNKNOWN → SENT | Depois do cenário 9, se a mensagem *de fato* chegou no WhatsApp de teste apesar do timeout registrado, aguarde o próximo evento `fromMe`/eco | `send_status` volta para `SENT` com o `provider_message_id` real; `meta` sem alteração inesperada |
| 11 | Nenhuma duplicação | Revise `messages` de todos os cenários acima | Nenhum texto idêntico chegou 2x no WhatsApp real (confira no próprio celular de teste, não só no banco) |
| 12 | Ordem cronológica correta | Revise a query de apoio ordenada por `received_at` para os cenários 2–4 | IN e OUT aparecem na ordem em que aconteceram de verdade, sem bolha fora de sequência |

## O que me devolver

Depois de rodar, me mande:
1. PASS/FAIL de cada um dos 12 (a tabela acima preenchida).
2. Os JSONs relevantes dos logs do `lead-worker` e `wa-webhook` para
   qualquer cenário que falhou — **remova `apikey`/tokens antes de colar**
   (o próprio `log()` do projeto já filtra chaves conhecidas, mas confira).
3. As duas queries SQL de apoio, resultado para os leads de teste usados.

Eu analiso, comparo com o que `AUDITORIA_F2_5.md` documenta como esperado,
listo diferenças reais entre o comportamento em Postgres isolado e o
comportamento com Evolution/WhatsApp de verdade, e só então a F3 entra em
pauta.
