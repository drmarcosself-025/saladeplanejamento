# V2 — Automação conversacional comercial

> **Status: aprovado. Fase 1 implementada** (migration `0003_turn_engine.sql`).
> Fases 2 a 5 seguem como desenho. Este documento é a fonte de verdade do
> projeto; `ARQUITETURA.md` (V1) continua válido no que não for contrariado
> aqui. O estado de cada fase está no fim do documento.

Mudança de eixo, em uma frase: a V1 responde **mensagem por mensagem**; a V2
responde **turno por turno** — espera a pessoa terminar de escrever, decide uma
vez, fala em bolhas e cancela o que ficou velho.

```
evento → identidade → persistência → debounce → lock por lead →
batch cronológico → política pré → contexto → 1 IA → política pós →
stale? → rate limit → OUT PENDING → delay → stale? → envio → OUT SENT →
(por bolha: stale?) → funil + temperatura + resumo → decision → push
```

Continua sendo: 2 Edge Functions, banco enxuto, 1 chamada de IA por rajada,
Kanban pequeno, sem múltiplos agentes.

---

## 1. Quais arquivos existentes serão alterados

| Arquivo | O que acontece | Tamanho da mudança |
|---|---|---|
| `_shared/normalize.ts` | **+ pequeno.** Extrair URLs do texto, expor `provider_timestamp` separado de `received_at`, tratar `stickerMessage` como tipo próprio já reconhecido (hoje já é), preservar `contextInfo.stanzaId` como `reply_to_provider_id`. Nenhuma regra de identidade/LID muda. | ~40 linhas |
| `_shared/policy.ts` | **Reescrita parcial.** Léxico passa a ter duas camadas: `HARD_RED` (sempre humano) e `CONTEXTUAL` (nome de procedimento só vira RED junto de marcador clínico em 1ª pessoa). Novas checagens pós-IA: URL literal na resposta, escassez/benefício inventado, nº de bolhas, pergunta por turno. | ~150 linhas |
| `_shared/ratelimit.ts` | **Correção importante** (ver §12, risco 9): limites passam a contar **turnos**, não mensagens — senão o intervalo mínimo de 20s bloquearia a 2ª e a 3ª bolha do mesmo turno. Ganha `bubbleGap` e `maxBubbles`. | ~50 linhas |
| `_shared/ai.ts` | Schema V2 (§3), prompt com playbook/objetivo comercial/horário/memória estruturada, `reply_messages[]` no lugar de `reply`. Os dois adaptadores (Anthropic/OpenAI) continuam como estão. | ~200 linhas |
| `_shared/funnel.ts` | **Quase intacto.** Só ganha a exceção do item 23: sinal forte de agendamento pode saltar direto para `SCHEDULING` sem o "um degrau por vez". | ~20 linhas |
| `_shared/evolution.ts` | Ganha resultado `UNKNOWN` (timeout/erro de rede ≠ falha confirmada) e `sendPresence` opcional (“digitando…”). | ~40 linhas |
| `_shared/config.ts` | Novas chaves (debounce, delays, lease, limiares de push, timezone, links permitidos, escassez). | ~50 linhas |
| `wa-webhook/index.ts` | Passa a gravar `provider_timestamp`/`received_at`/`content_hash` e a enfileirar **job por lead com debounce**, não job por mensagem. O resto (secret, normalização, espelhamento legado, takeover) fica igual. | ~40 linhas |
| `lead-worker/index.ts` | **Maior mudança.** Vira orquestrador de turno: claim com lock por lead → monta batch → política → IA → política → laço de bolhas com checagem de stale entre elas → outbox → funil/temperatura → decision → push. | ~350 linhas (hoje ~330) |
| `web/app.js` + `app.css` + `index.html` | Card com temperatura/score/emoji, ordenação por prioridade (§51), links clicáveis, e o bloco de PWA/push (botão “Ativar notificações”). | ~200 linhas |
| **Novos** | `_shared/batch.ts` (debounce/batch/stale), `_shared/outbox.ts` (PENDING/SENT/UNKNOWN), `_shared/playbook.ts` (objetivos + seeds por serviço), `_shared/clock.ts` (timezone/expediente), `_shared/push.ts`, `web/manifest.json`, `web/sw.js` | — |

Nada é jogado fora. As RPCs `ingest_outbound_event`, `finish_job`,
`get_send_stats` e toda a normalização de LID continuam.

---

## 2. Migrations necessárias

Duas, separadas de propósito — a segunda pode ser aprovada depois.

> **Ajuste na execução:** a migration foi entregue dividida por fase, não em
> bloco. `0003_turn_engine.sql` (Fase 1, já aplicada) traz só o que o motor de
> turno usa: cronologia, outbox, `turn_id`, desfechos e o novo modelo de `jobs`.
> As colunas comerciais desta seção (`lead_temperature`, `booking_intent_score`,
> `service_category`, `scheduling_preference`, objeção, sinal de compra e
> notificação) entram junto da Fase 3, quando passam a ser preenchidas —
> coluna que ninguém escreve é dívida, não fundação. `followup_step` fica
> adiado com o motor de cadência, conforme decidido.

### `0003_conversation_engine.sql`

**`leads` (+11 colunas, todas nullable ou com default):**
`lead_temperature` (`COLD|WARM|HOT`, default `COLD`), `booking_intent_score`
(`int 0-100`, default 0), `service_category`, `last_buying_signal`,
`last_objection`, `scheduling_preference`, `hot_lead_at`,
`hot_lead_notified_at`, `last_inbound_at`, `last_outbound_at`,
`followup_status` (default `NONE`), `next_followup_at`, `followup_step`.

> Revisão de necessidade real, como você pediu: `service_category` e
> `scheduling_preference` **não estavam** na sua lista do item 49 mas aparecem
> no schema de saída (§43) e no item 24 — sem coluna, viram texto perdido no
> resumo. Proponho incluir. `followup_step` só faz sentido junto do motor de
> cadência (item 46): proponho **adiar** essa coluna. Decisão sua.

**`messages` (+4 colunas):** `provider_timestamp`, `received_at` (default
`now()`), `send_status` (`PENDING|SENT|UNKNOWN|FAILED`, só para OUT),
`reply_to_message_id`, `content_hash`, `links jsonb`.

Índices novos:
`messages (lead_id, received_at, id)` para ordenação cronológica estável;
`messages (lead_id) where direction='IN' and processed = false` para o batch;
`unique (lead_id, content_hash) where direction='OUT' and created_at > ...`
não é possível com índice (predicado não-imutável) → dedupe de bolha fica na
RPC de outbox, não no índice.

**`automation_decisions` (+7):** `conversation_goal`, `next_best_action`,
`buying_signal`, `objection`, `notify_owner`, `notification_reason`,
`batch_message_ids uuid[]`, `outcome` (`SENT|STALE|BLOCKED|FAILED`).

**`jobs` — mudança de modelo (a mais estrutural):**
- sai `message_id uuid unique`; entra `run_after timestamptz`,
  `first_pending_at timestamptz`, `locked_by text`, `lease_until timestamptz`;
- entra índice **parcial único** `unique (lead_id) where status = 'PENDING'` →
  um único job pendente por lead (é o que dá o debounce “nova mensagem reinicia
  a janela”);
- `PENDING` + `RUNNING` do mesmo lead podem coexistir: é exatamente o caso
  “chegou mensagem enquanto eu processava”.

**RPCs novas/alteradas:**
`ingest_inbound_message` (altera: grava timestamps/hash e faz o upsert do job
com debounce em vez de `insert` por mensagem);
`claim_lead_jobs` (substitui `claim_jobs`: lock por lead + lease);
`fetch_batch` (mensagens não processadas do lead em ordem);
`is_batch_stale` (checagem exata por conjunto de ids);
`close_batch` (marca processadas + fecha job, transacional);
`reclaim_expired_jobs`;
`get_turn_stats` (substitui `get_send_stats`: conta turnos, não mensagens).

### `0004_push_pwa.sql`
`push_subscriptions` (id, user_id, endpoint unique, p256dh, auth, user_agent,
created_at, last_seen_at, failed_at) + RLS: o próprio usuário autenticado
insere/apaga a sua; o worker (service role) lê todas.

---

## 3. Schema final do Structured Output V2

Uma chamada, um objeto. Tudo validado no backend antes de qualquer envio.

```json
{
  "intent": "orthodontics",
  "service_category": "ALIGNERS",
  "treatment_interest": "invisalign",

  "stage": "INTEREST",
  "lead_temperature": "WARM",
  "booking_intent_score": 62,

  "buying_signal": "Demonstrou interesse no tratamento",
  "objection": "PRICE",

  "conversation_goal": "HANDLE_OBJECTION",
  "next_best_action": "QUALIFY_PREVIOUS_EVALUATION",

  "risk": "MEDIUM",
  "confidence": 0.95,

  "action": "AUTO_REPLY",
  "needs_human": false,
  "human_reason": null,

  "notify_owner": false,
  "notification_reason": null,

  "scheduling_preference": null,
  "link_keys": [],

  "reply_messages": [
    "O valor varia bastante conforme o planejamento e o número de alinhadores 😊",
    "Você já chegou a fazer alguma avaliação para Invisalign antes?"
  ],

  "summary": "Lead interessado em Invisalign, trouxe objeção de preço e ainda está em fase de avaliação."
}
```

**Enums:** `service_category` ∈ {ORTHODONTICS, ALIGNERS, HOF, WHITENING,
IMPLANT, PROSTHESIS, RESTORATIVE, GENERAL_DENTISTRY, OTHER} ·
`stage` ∈ {NEW, CONVERSATION, INTEREST, SCHEDULING} (CONVERTED/LOST não
existem para a IA) · `lead_temperature` ∈ {COLD, WARM, HOT} ·
`objection` ∈ {NONE, PRICE, TIME, DISTANCE, FEAR, TRUST, PAYMENT,
PARTNER_DECISION, JUST_RESEARCHING, OTHER} · `conversation_goal` ∈ os 9 do
item 16 · `action` ∈ {AUTO_REPLY, HUMAN, IGNORE} · `risk` ∈ {LOW, MEDIUM, HIGH}.

**Validações determinísticas no backend (qualquer falha ⇒ não envia nada):**

| Regra | Motivo |
|---|---|
| `reply_messages` com 1 a `MAX_BUBBLES` (3) itens, cada um ≤ 350 chars | item 12 |
| no máximo **uma** frase interrogativa no conjunto | item 13 |
| nenhuma bolha contém `http`, `www.` ou domínio literal | item 32 |
| `link_keys` só aceita chaves de `CLINIC_ALLOWED_LINKS`; backend substitui o token `{{MAPS}}` pela URL real | item 32 |
| nenhum padrão monetário (já existe na V1) | item 26 |
| nenhum padrão de escassez/benefício (`última vaga`, `só hoje`, `cortesia`, `você ganhou`) salvo `scarcity_allowed = true` | itens 27–28 |
| `booking_intent_score` 0–100 coerente com `stage`: score ≥ limiar exige `stage = SCHEDULING` | item 20 |
| `confidence ≥ AI_MIN_CONFIDENCE` | V1 |
| `needs_human` da IA **soma** com o veredito determinístico (união, nunca substituição) | item 30 |

---

## 4. Algoritmo exato de debounce

Config: `MESSAGE_DEBOUNCE_SECONDS = 5`, `DEBOUNCE_MAX_WAIT_SECONDS = 30`.

**Na entrada (dentro da transação de `ingest_inbound_message`):**

```sql
insert into jobs (lead_id, status, first_pending_at, run_after)
values (v_lead, 'PENDING', now(), now() + debounce)
on conflict (lead_id) where status = 'PENDING'
do update set
  run_after = least(
     now() + debounce,                             -- janela reinicia
     jobs.first_pending_at + max_wait              -- ...mas não indefinidamente
  );
```

Ou seja: cada mensagem nova empurra a janela para frente; o teto
`first_pending_at + 30s` impede que alguém que digita sem parar nunca seja
respondido (§12, risco 7).

**Disparo (sem depender de granularidade de cron):** o `wa-webhook` invoca o
`lead-worker` sem esperar, e o worker **dorme** `debounce + jitter` (máx.
`WORKER_MAX_WAIT_MS`) antes de tentar o claim. Como o claim só pega jobs com
`run_after <= now()`, o worker acordado por uma mensagem que não foi a última
não pega nada e encerra — quem responde é o worker disparado pela **última**
mensagem da rajada. Cinco mensagens em 10s ⇒ 5 workers acordados, 1 claim, 1
chamada de IA.

`pg_cron` continua como rede de segurança (retries com backoff, jobs órfãos),
agora a cada 30s.

**Resultado esperado** para a rajada do item 8: um batch com as 4 mensagens em
ordem, uma chamada de IA, uma resposta em 1–3 bolhas.

---

## 5. Algoritmo exato de lock por lead

Sem advisory lock: o processamento de um turno atravessa várias chamadas HTTP
(IA + Evolution) e o Supabase usa conexões em pool — não dá para segurar lock
de sessão. Usamos **lease em linha**, que sobrevive a worker morto.

```sql
-- claim_lead_jobs(p_limit, p_worker_id, p_lease_seconds)
update jobs j
   set status='RUNNING', attempts=attempts+1,
       locked_by=p_worker_id, locked_at=now(),
       lease_until = now() + make_interval(secs => p_lease_seconds)
 where j.id in (
   select q.id from jobs q
    where q.status='PENDING'
      and q.run_after      <= now()
      and q.next_attempt_at<= now()
      and not exists (                        -- ← o lock por lead
        select 1 from jobs r
         where r.lead_id = q.lead_id
           and r.status  = 'RUNNING'
           and r.lease_until > now()
      )
    order by q.run_after
    limit p_limit
    for update skip locked
 )
returning j.id, j.lead_id;
```

Três camadas cooperando:
1. **índice parcial único** (`lead_id where status='PENDING'`) → nunca existem
   dois pendentes do mesmo lead;
2. **`NOT EXISTS ... RUNNING`** → não claima lead que já está sendo processado;
3. **`FOR UPDATE SKIP LOCKED`** → dois workers simultâneos nunca pegam a mesma
   linha.

Leads diferentes seguem em paralelo (o worker processa os jobs claimados
concorrentemente, já que por construção são leads distintos).

**Lease expirado** (worker morreu, deploy no meio, timeout de plataforma):
`reclaim_expired_jobs()` volta `RUNNING` com `lease_until < now()` para
`PENDING`. `JOB_LEASE_SECONDS = 120` precisa ser **maior** que o pior turno
(delay + 3 bolhas + IA ≈ 40s), com folga.

---

## 6. Algoritmo exato para detectar resposta stale

Watermark por **conjunto de identidade**, não por relógio — timestamp do
WhatsApp pode vir torto e `received_at` pode empatar no mesmo milissegundo.

Ao montar o batch, o worker guarda `batch_ids uuid[]`. A checagem é:

```sql
-- is_batch_stale(p_lead_id, p_batch_ids) → boolean
select exists (
  select 1 from messages
   where lead_id = p_lead_id
     and direction = 'IN'
     and processed = false
     and id <> all (p_batch_ids)
);
```

Chegou qualquer mensagem do lead que não está no batch ⇒ **stale**.

Pontos de checagem (todos obrigatórios):

| # | Quando | Se stale |
|---|---|---|
| 1 | logo após a IA responder | descarta a resposta, `outcome=STALE`, **não** marca o batch como processado |
| 2 | depois do delay natural, imediatamente antes da 1ª bolha | idem |
| 3 | antes de **cada** bolha seguinte (item 10) | cancela as bolhas restantes; marca o batch como processado (já houve resposta) e fecha com `outcome=STALE_PARTIAL` |

Em todos os casos o job atual termina como `DONE` — quem reprocessa é o job
`PENDING` que a mensagem nova já criou (com a janela de debounce). Diferença
importante entre os casos:

- **stale antes de qualquer bolha** → batch continua não processado ⇒ o próximo
  turno reúne mensagens antigas + novas ⇒ uma única resposta coerente;
- **stale no meio das bolhas** → batch vira processado ⇒ o próximo turno vê no
  histórico o que já foi dito e responde só ao que é novo.

Assim nunca sai a “versão velha da conversa”, e nunca sai a pergunta que o lead
já respondeu.

---

## 7. Fluxo OUT PENDING / SENT / UNKNOWN

Por bolha, sempre nesta ordem:

```
1. INSERT messages (direction=OUT, sender_type=AI, send_status='PENDING',
                    content_hash, provider_message_id=NULL)
        ← a linha nasce ANTES do envio (mata a corrida com o eco fromMe)
2. dedupe: se já existe OUT com o mesmo content_hash nos últimos
   OUTBOX_DEDUPE_SECONDS (120), aborta a bolha (worker zumbi)
3. POST Evolution /message/sendText
4a. HTTP 2xx  → send_status='SENT',  provider_message_id = key.id
4b. HTTP 4xx/5xx explícito → send_status='FAILED' (não foi entregue)
4c. timeout / erro de rede → send_status='UNKNOWN'   ← NUNCA reenviar
5. UNKNOWN encerra a sequência de bolhas do turno e marca o lead
   needs_human = true (a equipe decide olhando o WhatsApp)
```

`FAILED` pode ser retentado pelo job (backoff); `UNKNOWN` não — é a única forma
honesta de não duplicar mensagem para o lead. O painel mostra o estado da
bolha.

A detecção de human takeover (`ingest_outbound_event`) passa a casar por
`content_hash` além do texto, e só considera intervenção humana o `fromMe` que
não bate com nenhuma linha `PENDING`/`SENT`/`UNKNOWN` recente.

---

## 8. Regras de push

**Eventos:** `HOT_LEAD`, `HUMAN_REQUIRED`, `CRITICAL_AUTOMATION_FAILURE`.
Nunca push por mensagem recebida.

**HOT_LEAD dispara quando** (`booking_intent_score >= HOT_LEAD_THRESHOLD`,
default 75) **ou** entrada válida em `SCHEDULING`, **e**:
- `hot_lead_notified_at is null` **ou** `now() - hot_lead_notified_at >
  HOT_LEAD_RENOTIFY_HOURS` (default 12h);
- a decisão do turno não é `STALE`.
Ao disparar: grava `hot_lead_at` (primeira vez) e `hot_lead_notified_at`.

**HUMAN_REQUIRED dispara** na transição `ACTIVE → HUMAN_REQUIRED` (só na
transição, não a cada mensagem subsequente).

**CRITICAL_AUTOMATION_FAILURE:** job em `FAILED` após esgotar tentativas, ou
`UNKNOWN` no envio. Agregado: no máximo 1 push a cada 30 min.

**Silêncio noturno:** fora do expediente, `HOT_LEAD` respeita
`PUSH_QUIET_HOURS` (default 22:00–07:00, timezone da clínica) e é entregue na
abertura da janela; `HUMAN_REQUIRED` clínico ignora quiet hours.

**Entrega:** Web Push (VAPID) direto do `lead-worker`, lendo
`push_subscriptions`. `410 Gone` / `404` ⇒ apaga a inscrição. Payload = título,
corpo curto e `lead_id`; o service worker abre
`/dental-leads/web/?lead=<id>`, que abre o drawer daquele lead (item 41).

> **Ponto que precisa da sua decisão:** Web Push exige VAPID (assinatura ES256 +
> criptografia aes128gcm). Prefiro `npm:web-push` dentro do `lead-worker` (sem
> function nova). Se o runtime do Supabase não engolir essa lib, o plano B é
> implementar VAPID com WebCrypto (~150 linhas) — e o plano C, mais barato, é
> abrir mão de push real e usar notificação local do PWA enquanto a aba estiver
> aberta. Recomendo A, com B como contingência.

---

## 9. Impacto no schema atual

| Objeto | Impacto | Perda de dado? |
|---|---|---|
| `leads` | só colunas novas | não |
| `messages` | só colunas novas; `received_at` retroage com `created_at` | não |
| `automation_decisions` | só colunas novas | não |
| `jobs` | **quebra**: sai `message_id unique`, entra unique parcial por lead | não (fila vazia entre deploys; jobs pendentes seriam migrados 1:1 para job por lead) |
| `claim_jobs` | substituída por `claim_lead_jobs` | função antiga é dropada |
| `get_send_stats` | substituída por `get_turn_stats` | idem |
| RLS/grants | `+ push_subscriptions`; grant de update do painel ganha `lead_temperature`? **não** — temperatura é do sistema, o painel não edita | não |

Como o sistema **ainda não está em produção**, a migration pode ser aplicada
sem janela de manutenção. Se já estivesse rodando, o caminho seria: pausar o
cron → drenar `jobs` → aplicar → religar.

---

## 10. O que continua intacto

- toda a normalização de identidade: `remoteJid`, `remoteJidAlt`, `senderPn`,
  LID nunca virando telefone, `phone = null`, `whatsapp_id` como identidade;
- desembrulho de wrappers do Baileys e descarte de grupo/status/broadcast/
  newsletter/reação/protocolo;
- idempotência por `provider_message_id UNIQUE`;
- persistência transacional antes de responder 200 à Evolution;
- espelhamento opcional para o CRM antigo (`LEGACY_WEBHOOK_URL`);
- human takeover e sua janela de graça (ganha `content_hash`, não muda de
  conceito);
- Policy Engine como camada determinística com poder de veto — só fica mais
  esperto;
- rate limit centralizado em um único portão (muda a unidade de contagem);
- proteção de secrets, RLS, comparação de secret em tempo constante, painel sem
  service role;
- funil sem regressão automática e `CONVERTED`/`LOST` manuais;
- 2 Edge Functions, 1 chamada de IA por unidade conversacional.

---

## 11. Testes que serão adicionados

Cobrindo o item 48. Os 26 casos atuais continuam.

**Identidade (4):** número comum · LID puro · LID com `remoteJidAlt` · lead
existente reencontrado pelo `whatsapp_id`.

**Rajada (4):** 1 mensagem · 3 rápidas · 10 rápidas · digitação contínua
batendo no teto de `DEBOUNCE_MAX_WAIT`.

**Cronologia (3):** timestamps a 1s de distância · evento fora de ordem
(provider_timestamp menor chegando depois) · empate exato de `received_at`.

**Stale (4):** chega durante a IA · chega depois do delay e antes da 1ª bolha ·
chega entre bolha 1 e 2 (as bolhas 2/3 **não** saem) · não chega nada
(caminho feliz completo).

**Concorrência (3):** dois workers e o mesmo lead (só um claima) · dois leads
diferentes (ambos processam) · lease expirado é reclaimado sem duplicar envio.

**Conversa (10):** pergunta genérica · Invisalign · HOF · implante · preço ·
distância · medo · parcelamento · “vou pensar” · “quero marcar” (este último
verificando que **não** há qualificação extra e que vai para `SCHEDULING`).

**Segurança (7):** dor · inchaço · medicamento · exame · foto · reclamação ·
**e o caso do item 30**: “vocês fazem canal?” (comercial, responde) vs “meu
dente dói, será que é canal?” (humano).

**WhatsApp (6):** emoji preservado · sticker isolado (não chama IA) · sticker +
texto (processa o texto) · link recebido preservado e clicável · mídia não
quebra a conversa · `fromMe` manual dispara takeover.

**Horário (3):** dentro do expediente · madrugada (não promete humano agora) ·
domingo.

**Envio (4):** timeout ⇒ `UNKNOWN` e sem reenvio · envio confirmado ⇒ `SENT` ·
`FAILED` ⇒ retry com backoff · dedupe por `content_hash`.

**Push (4):** HOT dispara uma vez · HUMAN_REQUIRED só na transição ·
duplicidade suprimida na janela de renotificação · deep link abre o drawer certo.

**Validação de saída (5):** mais de 3 bolhas ⇒ bloqueia · duas perguntas ⇒
bloqueia · URL literal ⇒ bloqueia · escassez inventada ⇒ bloqueia · score alto
com `stage` incoerente ⇒ bloqueia.

Total estimado: ~60 casos novos. Os que dependem de banco (lock, claim, stale,
debounce) precisam de Postgres real — proponho um script
`tests/db/` rodável contra um projeto Supabase de teste ou `supabase start`
local, porque lock e corrida não se testam com mock.

---

## 12. Riscos de corrida ainda não resolvidos (e o que faço com cada um)

1. **Janela final stale → POST na Evolution.** Entre a última checagem e o
   envio de fato existem ~200ms–2s. É teoricamente impossível fechar sem
   transação distribuída com a Evolution. *Mitigação:* a checagem é a última
   instrução antes do `fetch`, e todo delay natural acontece **antes** dela.
   Risco residual aceito e documentado.
2. **Worker zumbi após expirar o lease.** Um worker lento pode acordar e enviar
   depois de outro ter assumido o lead. *Mitigação:* dedupe por `content_hash`
   na janela de 120s + `lease` folgado. Residual: bolhas fora de ordem em caso
   extremo.
3. **`UNKNOWN` é ambíguo por natureza** — a Evolution pode ter entregado. Não
   há retry automático; vira caso humano.
4. **Relógio do WhatsApp vs. do servidor.** `provider_timestamp` pode vir
   adiantado/atrasado. *Mitigação:* ordenação por `(received_at, id)` e stale
   por conjunto de ids; `provider_timestamp` só informa o prompt e o painel.
5. **Debounce vs. resposta em bolhas do lead.** Se o lead escreve enquanto a IA
   responde, o turno é cancelado — mas ele pode ter escrito exatamente porque
   viu a bolha 1. É comportamento correto (reprocessa com contexto novo), com o
   custo de uma chamada de IA a mais. Aceito.
6. **Reentrega da Evolution durante o turno.** Mensagem repetida com o mesmo
   `provider_message_id` não entra (UNIQUE), então não dispara stale falso.
7. **Lead que digita sem parar.** Resolvido pelo teto
   `DEBOUNCE_MAX_WAIT_SECONDS`.
8. **Limite de parede da Edge Function.** Turno = delay + 3 bolhas + IA. Com os
   defaults propostos fica em ~15–40s, dentro do orçamento, mas `batchSize`
   grande + processamento sequencial estouraria. *Mitigação:* jobs claimados
   são processados em paralelo, `WORKER_BATCH_SIZE = 3`, e um orçamento de
   parede que aborta antes do limite devolvendo o job para a fila.
9. **Rate limit vs. bolhas (bug real que a V2 introduziria).** Hoje
   `RATE_LIMIT_MIN_INTERVAL = 20s` compara com a última mensagem OUT — com
   bolhas, a bolha 2 seria bloqueada pela bolha 1. *Correção obrigatória:* o
   limite passa a contar **turnos** (via `automation_decisions`), e o
   espaçamento entre bolhas vira `OUTBOUND_BUBBLE_DELAY_MIN/MAX_MS`.
10. **Push duplicado por dois turnos quase simultâneos.** Resolvido por
    `hot_lead_notified_at` + janela de renotificação.

---

## Decisões que dependem de você antes de eu codificar

1. **`followup_step`** — incluir agora (barato, fica ocioso) ou adiar junto do
   motor de cadência? *Recomendo adiar.*
2. **`service_category` e `scheduling_preference` em `leads`** — não estavam na
   sua lista do item 49, mas sem elas a informação se perde. *Recomendo incluir.*
3. **Push:** `npm:web-push` no `lead-worker` (plano A) com VAPID manual como
   contingência. *Recomendo A.*
4. **Playbook comercial:** você mencionou material do consultório (ortodontia/
   alinhadores/HOF). Para o `_shared/playbook.ts` sair fiel, preciso desse
   material — ou eu escrevo os seeds a partir dos princípios do item 15 e você
   revisa depois.
5. **Defaults propostos:** `MESSAGE_DEBOUNCE_SECONDS=5`,
   `DEBOUNCE_MAX_WAIT_SECONDS=30`, `RESPONSE_DELAY 2000–5000ms`,
   `BUBBLE_DELAY 1500–3500ms`, `MAX_BUBBLES=3`, `HOT_LEAD_THRESHOLD=75`,
   `JOB_LEASE_SECONDS=120`, `WORKER_BATCH_SIZE=3`.
6. **Ordem de implementação sugerida** (cada fase entregável e testável):
   **F1** cronologia + debounce + lock + batch (sem mudar a IA) →
   **F2** stale + bolhas + outbox PENDING/SENT/UNKNOWN →
   **F3** schema V2 + playbook + temperatura/objeção + política contextual →
   **F4** push + PWA →
   **F5** ordenação e visual do Kanban.
   Assim o motor conversacional entra antes do comercial, e cada fase é
   revisável sozinha.

---

## Estado da implementação

### Fase 1 — cronologia, debounce, lock por lead e batch ✅

Entregue em `0003_turn_engine.sql` + `_shared/turn.ts` + reescrita do
`lead-worker`. As emendas da revisão estão todas dentro:

| Emenda | Onde ficou |
|---|---|
| job por lead + índice parcial único `PENDING` | `jobs_one_pending_per_lead` |
| `debounce_started_at` com teto medido desde o início da rajada | `ingest_inbound_message`, nunca reescrito no `ON CONFLICT` |
| lease com heartbeat + reclaim | `renew_lease`, `reclaim_expired_jobs` |
| `assertTurnStillValid()` nos três pontos | `assert_turn_valid` (RPC) + `_shared/turn.ts` |
| job é sinal, não dono de mensagem; batch montado no claim | `fetch_batch` |
| desfechos explícitos | enum `turn_outcome` |
| `turn_id` em todas as bolhas e na decisão | `messages.turn_id`, `automation_decisions.turn_id` |
| outbox por bolha com `sequence` e `send_status` | `messages.bubble_sequence` / `send_status` |
| rate limit por turno | `get_turn_stats` + `canSendMessage` |
| cadência adiada, só `last_inbound_at`/`last_outbound_at` | `leads` |

**Quando o lease é renovado** (`renew_lease`): logo após a chamada de IA — a
operação mais longa do turno — e, na Fase 2, antes da primeira bolha e depois
de cada bolha enviada. Se a renovação falhar, o worker perdeu a posse do lead e
**aborta sem enviar nada**: outro worker já assumiu.

**Regra que decide o resto:** o batch só é marcado como processado quando
alguma bolha saiu. Turno abortado antes de qualquer envio devolve as mensagens
para o próximo batch — assim o lead recebe uma resposta coerente, e não duas
parciais.

#### O que foi verificado de verdade

`tests/db/turn_engine_test.sql` roda contra Postgres real (13 casos, todos
passando): debounce agrupando a rajada, teto de espera, reentrega da Evolution,
claim respeitando janela e lock, batch em ordem cronológica, `assert_turn_valid`
nos seus seis motivos de recusa, `close_turn` com e sem envio, retry com
backoff, esgotamento de tentativas virando caso humano, reclaim de lease
expirado, renovação só pelo dono, dois leads em paralelo, takeover cancelando
turno e eco da própria bolha **não** virando takeover.

`tests/db/concurrency_test.sh` sobe 8 workers simultâneos disputando 2 leads:
resultado exato de 2 turnos claimados, um por lead. É o teste que o script
transacional não consegue fazer.

Dois defeitos reais apareceram só quando o SQL rodou de verdade:

1. **`now()` vs `clock_timestamp()`** — `now()` é o horário de início da
   transação. Mensagens gravadas na mesma transação recebiam `received_at`
   idêntico, empatando a ordem cronológica e neutralizando o empurrão da janela
   de debounce. A cronologia agora usa `clock_timestamp()`.
2. **`next_attempt_at` nascendo no futuro** — quando vinha do relógio de
   parede, ficava marginalmente à frente do `now()` do claim e o turno nascia
   inelegível. Passou a ser `now()`; a espera da rajada é responsabilidade
   exclusiva do `run_after`.

### Fases seguintes (desenho aprovado, ainda não implementado)

- **F2** — `reply_messages[]` em bolhas, `assertTurnStillValid` entre cada
  bolha, `PARTIAL_STALE` registrando quais bolhas saíram e cancelando o resto
  sem aplicar resumo/etapa da decisão obsoleta, outbox `CANCELLED`.
- **F3** — Structured Output V2 completo (temperatura, score de agendamento,
  objeção, objetivo comercial), playbook por serviço, política contextual
  (“vocês fazem canal?” ≠ “meu dente dói, será canal?”), links por chave
  autorizada, horário/expediente no prompt.
- **F4** — push (`web-push` testado no Supabase antes de fixar a
  implementação), `push_subscriptions` como tabela de infraestrutura, PWA com
  deep link para o card.
- **F5** — Kanban com temperatura, prioridade visual e ordenação por urgência.
