# Arquitetura — Automação de leads odontológicos via WhatsApp (V1)

> Projeto **novo e separado** do CRM Maison D'Or que existe na raiz deste repositório.
> Nada em `/index.html`, `/supabase/` ou `/30d/` é lido, importado ou alterado por este projeto.
> Tudo deste projeto vive dentro de `dental-leads/`.

Princípio que governa cada decisão abaixo:
**a IA pensa, o servidor decide e executa.**

---

## A. Arquitetura final proposta

```
        WhatsApp (número já conectado)
                  │
         Evolution API (já existe, na Hetzner/EasyPanel — não será reinstalada)
                  │  webhook  MESSAGES_UPSERT
                  ▼
    ┌─────────────────────────────────────┐
    │  Edge Function: wa-webhook          │   valida secret
    │  normaliza → valida → 1 RPC transac. │   (nunca chama IA)
    └───────────────┬─────────────────────┘
                    │  RPC ingest_inbound_message()  (transação única)
                    ▼
    ┌─────────────────────────────────────┐
    │  Postgres (Supabase Free)            │
    │  leads · messages · automation_      │
    │  decisions  (+ jobs = infra)         │
    └───────────────┬─────────────────────┘
                    │  fila = tabela jobs (FOR UPDATE SKIP LOCKED)
                    │
      disparo primário: wa-webhook invoca lead-worker sem esperar
      rede de segurança: pg_cron a cada 1 min varre jobs pendentes
                    ▼
    ┌─────────────────────────────────────┐
    │  Edge Function: lead-worker         │
    │  1. Policy Engine (pré-IA)          │
    │  2. 1 chamada de IA (structured)    │
    │  3. Policy Engine (pós-IA)          │
    │  4. canSendMessage() (rate limit)   │
    │  5. Evolution sendText              │
    │  6. grava decisão + move funil      │
    └───────────────┬─────────────────────┘
                    ▼
        Evolution API → WhatsApp → lead

    Painel (Kanban estático, GitHub Pages)
        └── supabase-js (anon key + login) → Postgres com RLS
```

Total: **2 Edge Functions, 4 tabelas (3 de aplicação + 1 de infra), 1 chamada de IA por mensagem elegível.**

Sem LangChain, sem n8n, sem Make, sem RAG, sem vector DB, sem múltiplos agentes, sem servidor novo.

### Por que assim

| Decisão | Alternativa descartada | Motivo |
|---|---|---|
| Fila em tabela `jobs` | pgmq / Supabase Queues | Volume é de dezenas de mensagens/dia, não milhares/s. Tabela dá auditoria, retry com backoff visível e depuração com `select`. pgmq acrescenta extensão, semântica de visibility timeout e mensagens que somem da vista. Ver seção F. |
| 2 functions | webhook único fazendo tudo | O webhook não pode esperar a IA (Evolution tem timeout e faz retry — retry com IA no meio = resposta duplicada). |
| Postgres RPC transacional | vários `insert` do JS | Item 9: só devolver 200 depois que mensagem + lead + job estão gravados **atomicamente**. |
| Identidade = JID, não telefone | agrupar por telefone | Erro conhecido do CRM antigo (LID vira conversa duplicada). Ver seção L. |
| Polling de 20s no painel | Supabase Realtime | Realtime só se necessário. Kanban de clínica não precisa de sub-segundo. |

---

## B. Estrutura de pastas

```
dental-leads/
├── ARQUITETURA.md              ← este documento
├── README.md                   ← passo a passo de deploy
├── .env.example                ← todas as variáveis, nenhum valor real
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 0001_init.sql       ← tipos, tabelas, índices, RPCs, RLS
│   │   └── 0002_cron.sql       ← rede de segurança (pg_cron + pg_net)
│   └── functions/
│       ├── _shared/
│       │   ├── config.ts       ← TODA configuração/env em um lugar só
│       │   ├── normalize.ts    ← normalizeWhatsAppEvent()
│       │   ├── policy.ts       ← evaluateAutomationPolicy() GREEN/YELLOW/RED
│       │   ├── ratelimit.ts    ← canSendMessage()
│       │   ├── funnel.ts       ← transições de etapa permitidas
│       │   ├── ai.ts           ← adaptador de provedor + JSON schema
│       │   ├── evolution.ts    ← sendText (único ponto de envio)
│       │   └── http.ts         ← json(), log sem secrets
│       ├── wa-webhook/index.ts
│       └── lead-worker/index.ts
├── web/                        ← Kanban estático (GitHub Pages)
│   ├── index.html
│   ├── app.css
│   ├── app.js
│   └── config.js               ← só SUPABASE_URL + anon key (nunca service role)
├── tests/
│   ├── normalize_test.ts
│   └── policy_test.ts
└── docs/
    └── evolution-webhook.md    ← como apontar o webhook sem quebrar o CRM antigo
```

---

## C. Schema SQL completo

Arquivo real: `supabase/migrations/0001_init.sql`. Resumo do que ele cria:

**Enums:** `lead_stage`, `lead_status`, `automation_status`, `message_direction`, `sender_type`, `risk_level`, `decision_action`, `job_status`.

**`leads`** — identidade é `whatsapp_id` (JID normalizado), *não* telefone.
```
id, whatsapp_id UNIQUE, phone (NULL permitido), is_lid, name,
stage, status, treatment_interest, automation_status, needs_human,
human_reason, conversation_summary, last_message_at, created_at, updated_at
```
`phone` só é preenchido quando o número real é conhecido com segurança. LID nunca vira telefone (`phone = NULL`, `is_lid = true`, identificador original preservado em `whatsapp_id`).

`status` (`OPEN`/`CLOSED`) é derivado de `stage` por trigger — existe só para o painel filtrar rápido, não é uma segunda fonte de verdade.

**`messages`** — memória operacional e auditoria, não WhatsApp Web.
```
id, lead_id, provider_message_id UNIQUE, direction, sender_type,
message_type, text, processed, meta (jsonb enxuto), created_at
```
`meta` guarda **apenas** os campos que já causaram problema em produção (`remoteJid`, `remoteJidAlt`, `participant`, wrapper detectado, `pushName`) — não o payload inteiro.

**`automation_decisions`** — responde "por que a IA respondeu isso?".
```
id, lead_id, message_id, intent, risk, confidence, action,
stage_before, stage_after, reason, reply_sent, ai_raw (jsonb), created_at
```

**`jobs`** (infra, não é tabela de aplicação)
```
id, lead_id, message_id UNIQUE, status, attempts, next_attempt_at,
last_error, locked_at, created_at, updated_at
```
`message_id UNIQUE` = a mesma mensagem nunca gera dois jobs.

**RPCs (toda escrita crítica é server-side e transacional):**
- `ingest_inbound_message(...)` → upsert do lead + insert da mensagem + enfileira, **em uma transação**. Retorna `{duplicate: bool, ...}`.
- `ingest_outbound_event(...)` → detecção de human takeover (seção G).
- `claim_jobs(limit)` → `FOR UPDATE SKIP LOCKED`.
- `finish_job(id, ok, error)` → backoff exponencial ou `FAILED`.

**RLS:** ligado em todas as tabelas. `anon` não tem nada. `authenticated` tem `SELECT` em leads/messages/automation_decisions e `UPDATE` **por coluna** (`GRANT UPDATE(stage, status, automation_status, needs_human, human_reason, treatment_interest)`) só em `leads`. `jobs` é invisível para o painel. Service role só nas Edge Functions.

---

## D. Fluxo de eventos (mensagem chegando → resposta saindo)

```
1.  Evolution POST /wa-webhook?  (header x-webhook-secret)
2.  wa-webhook valida secret            → 401 se errado
3.  normalizeWhatsAppEvent(payload)
      desembrulha ephemeral/viewOnce/documentWithCaption
      extrai jid, jidAlt, fromMe, tipo, texto, provider_message_id
      classifica: GROUP / BROADCAST / STATUS / NEWSLETTER / SYSTEM / REACTION
4.  descarta o que nunca chama IA (grupo, status, broadcast, reação, protocolo)
5.  fromMe? → ingest_outbound_event()   → possível HUMAN_TAKEOVER → 200
6.  senão → ingest_inbound_message()  [TRANSAÇÃO]
      upsert lead (por whatsapp_id)
      insert message (ON CONFLICT provider_message_id DO NOTHING)
      se já existia  → duplicate=true, NÃO enfileira, NÃO responde de novo
      se é mídia     → needs_human=true, automation_status=HUMAN_REQUIRED, não enfileira
      senão          → insert job PENDING
7.  só agora wa-webhook devolve 200. Falhou antes disso → 5xx (Evolution faz retry)
8.  wa-webhook dispara lead-worker sem esperar (fire-and-forget)
    (se esse disparo falhar, o pg_cron de 1 min pega o job mesmo assim)
────────────────────────────────────────────────────────────────
9.  lead-worker: claim_jobs()
10. Policy Engine PRÉ-IA
      automation_status ≠ ACTIVE?      → não chama IA, grava decisão, fim
      mídia / sem texto / opt-out?     → HUMAN_REQUIRED, fim
      palavra RED (dor, sangramento…)? → HUMAN_REQUIRED, resposta neutra autorizada, fim
11. monta contexto: conversation_summary + últimas 8 mensagens + mensagem atual
12. UMA chamada de IA (structured output)
13. valida JSON contra o schema → inválido? nada é enviado, decisão gravada com erro
14. Policy Engine PÓS-IA
      IA disse HUMAN / needs_human?        → não envia
      confiança < AI_MIN_CONFIDENCE?       → não envia
      categoria YELLOW e resposta contém valor em R$? → bloqueia (IA não inventa preço)
      resposta contém termo clínico proibido?         → bloqueia
      etapa sugerida inválida?             → ignora a sugestão, mantém a atual
15. canSendMessage()  (intervalo mínimo, limite/hora, limite/dia, takeover, duplicidade)
16. Evolution sendText  ← único ponto de envio do sistema inteiro
17. grava message OUT (com provider_message_id devolvido pela Evolution)
18. aplica transição de funil permitida + atualiza conversation_summary
19. grava automation_decisions
20. finish_job(ok)
```

Qualquer exceção entre 9 e 20 → `finish_job(erro)` → retry com backoff (2min, 8min, 32min) até `AI_MAX_ATTEMPTS`, depois `FAILED` (visível no painel como "precisa de humano").

---

## E. Edge Functions necessárias

Exatamente **duas**:

| Function | Responsabilidade | JWT |
|---|---|---|
| `wa-webhook` | Receber Evolution, normalizar, persistir, enfileirar. Nunca chama IA, nunca envia mensagem. | desligado (protegida por `x-webhook-secret`) |
| `lead-worker` | Consumir fila, aplicar política, chamar IA, aplicar política de novo, rate limit, enviar, gravar decisão. | desligado (protegida por `x-worker-secret`) |

O painel **não** precisa de function: fala direto com o Postgres via `supabase-js` + RLS. Toggle de IA, mover etapa, marcar perdido/convertido são `UPDATE` em colunas permitidas.

---

## F. Estratégia de Queue / retry

**Avaliação do pgmq (pedido no item 10):** pgmq resolve throughput alto e consumo concorrente. Aqui o volume é baixo, o valor está em *ver* o que travou, e a fila precisa mesmo ser auditável junto com o lead. Uma tabela `jobs` com `FOR UPDATE SKIP LOCKED` dá o mesmo comportamento (claim atômico, sem processamento duplo) com `select * from jobs where status='FAILED'` como ferramenta de diagnóstico. **Recomendação: não usar pgmq na V1.** Se um dia o volume justificar, a troca é local ao `claim_jobs`/`finish_job`.

- **Claim:** `UPDATE ... WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT n)` — dois workers simultâneos nunca pegam o mesmo job.
- **Backoff:** `next_attempt_at = now() + (2 ^ attempts) * WORKER_BACKOFF_BASE`.
- **Teto:** `WORKER_MAX_ATTEMPTS` (padrão 4) → `FAILED` + `needs_human = true` (nenhum lead morre em silêncio).
- **Disparo:** primário pelo webhook (latência ~1s); rede de segurança `pg_cron` a cada 1 min via `pg_net`. Os dois são idempotentes — se rodarem juntos, o `SKIP LOCKED` resolve.
- **Idempotência de ponta:** `messages.provider_message_id UNIQUE` + `jobs.message_id UNIQUE`. Webhook repetido não gera segunda resposta, segunda mensagem, nem segundo movimento de funil.

---

## G. Estratégia de human takeover

Estados: `ACTIVE` · `HUMAN_REQUIRED` · `HUMAN_TAKEOVER` · `PAUSED`.

| Estado | Quem coloca | IA responde? |
|---|---|---|
| `ACTIVE` | padrão | sim |
| `HUMAN_REQUIRED` | Policy Engine (RED, mídia, baixa confiança, job FAILED) | não |
| `HUMAN_TAKEOVER` | detecção automática de humano respondendo pelo celular | não |
| `PAUSED` | botão no painel | não |

**Detecção (item 12):** todo envio do sistema grava `provider_message_id` devolvido pela Evolution. Quando chega evento `fromMe`:

1. `provider_message_id` está em `messages` como nosso → é a nossa própria mensagem, ignora.
2. Não está → **humano respondeu pelo WhatsApp** → `automation_status = HUMAN_TAKEOVER`, grava a mensagem como `sender_type = HUMAN`.

**Corrida tratada:** existe uma janela de ~1s em que a Evolution pode entregar o `fromMe` da nossa mensagem antes de gravarmos o id. Por isso a regra 2 tem um segundo teste antes de declarar takeover: se existe mensagem `OUT`/`AI` com o **mesmo texto** nos últimos `TAKEOVER_GRACE_SECONDS` (padrão 120s), o evento é vinculado a ela em vez de virar takeover. Sem isso, o sistema se auto-desligaria a cada resposta.

Retorno para `ACTIVE` é **sempre manual**, pelo painel. Nunca automático.

---

## H. Estratégia de rate limit

Tudo em `canSendMessage()`; nenhum limite espalhado pelo código, nenhum número mágico.

Verificações, na ordem (a primeira que reprovar bloqueia e é registrada com o motivo):

1. `automation_status = ACTIVE`?
2. `needs_human = false`?
3. mensagem já processada / job duplicado?
4. intervalo desde o último envio automático ≥ `RATE_LIMIT_MIN_INTERVAL` (padrão 20s)
5. respostas automáticas para este lead na última hora < `RATE_LIMIT_HOURLY` (padrão 8)
6. respostas automáticas para este lead nas últimas 24h < `RATE_LIMIT_DAILY` (padrão 30)
7. texto idêntico à última resposta enviada (anti-loop)

Todos os valores vêm de env (`_shared/config.ts`), com defaults conservadores.

---

## I. Schema do Structured Output da IA

Uma chamada, um objeto. Validado no backend antes de qualquer envio.

```json
{
  "intent": "orthodontics",
  "treatment_interest": "invisalign",
  "stage": "INTEREST",
  "action": "AUTO_REPLY",
  "risk": "LOW",
  "confidence": 0.93,
  "needs_human": false,
  "human_reason": null,
  "reply": "Claro 😊 Você já usou aparelho antes ou seria o primeiro tratamento?",
  "summary": "Lead pergunta sobre Invisalign, primeiro contato, sem histórico ortodôntico informado."
}
```

- `action`: `AUTO_REPLY` | `HUMAN` | `IGNORE`
- `risk`: `LOW` | `MEDIUM` | `HIGH`
- `stage`: `NEW` | `CONVERSATION` | `INTEREST` | `SCHEDULING` (a IA **não** pode devolver `CONVERTED` nem `LOST`)
- `confidence`: 0..1
- `summary`: resumo curto que substitui `conversation_summary` — é assim que mantemos memória sem uma segunda chamada de IA.

Validação no backend: tipos, enums, faixa de confiança, `reply` não vazio quando `action = AUTO_REPLY`, tamanho máximo. **JSON inválido = nada é enviado**, a decisão é gravada com `reason = 'invalid_ai_json'` e o lead vai para `HUMAN_REQUIRED`.

Provedor é trocável por env (`AI_PROVIDER = anthropic | openai`). Anthropic usa tool com `input_schema` forçado; OpenAI-compatível (OpenAI, DeepSeek, Groq, OpenRouter…) usa `response_format: json_schema`. Trocar de modelo = trocar duas variáveis, zero código.

---

## J. Política GREEN / YELLOW / RED

Determinística, em `_shared/policy.ts`, roda **antes e depois** da IA. Palavras-chave em PT-BR com normalização de acento.

**RED — humano obrigatório, IA nunca responde conteúdo clínico.**
dor, dói, inchaço, inchado, sangramento, sangrando, pus, abscesso, infecção, febre, canal, extração, medicamento, antibiótico, remédio, alergia, anestesia, contraindicação, pós-operatório, cicatrização, ponto/sutura, raio-x, radiografia, exame, diagnóstico, "é canal?", emergência, urgência, reclamação, processo, reembolso, advogado, "quero falar com humano/atendente/pessoa", além de **qualquer mídia** (foto, áudio, vídeo, documento).
→ `needs_human = true`, `automation_status = HUMAN_REQUIRED`. Pode sair **uma** resposta neutra pré-autorizada (texto fixo em config, não gerado por IA): *"Vou pedir para alguém da equipe te responder aqui, tá? 🙏"*.

**YELLOW — resposta limitada.**
preço, valor, quanto custa, orçamento, parcelamento, desconto, convênio, plano, forma de pagamento, financiamento.
→ IA pode acolher e explicar como funciona, mas o backend **bloqueia qualquer resposta que contenha valor monetário** (`R$`, "reais", padrões numéricos de preço). Se a IA inventar um valor, a resposta é descartada e o lead vai para `HUMAN_REQUIRED`. Allowlist de preços autorizados fica para depois (não implementar agora).

**GREEN — pode responder automaticamente.**
localização, endereço, horário, estacionamento, tratamentos oferecidos, Invisalign, aparelho, alinhador, clareamento, lente, faceta, implante (comercial), como funciona a avaliação, primeiro contato, "quero melhorar meu sorriso", intenção de agendar.

A categoria pré-IA entra no prompt como restrição, e a categoria pós-IA é reaplicada sobre o texto gerado. Uma resposta só sai se **as duas passagens** aprovarem.

---

## K. O que fica fora da V1 (decidido, não esquecido)

Mini WhatsApp Web · chat interno · envio manual pelo painel · histórico navegável · foto de perfil · emoji picker · upload/mídia · download, transcrição ou vision de mídia · sincronização manual · contatos · campanhas · tarefas · checklist · templates · financeiro · prontuário · procedimentos clínicos · agenda · dashboard · relatórios · RAG · embeddings · vector database · múltiplos agentes · supervisor · automações genéricas · allowlist de preços · marcação automática de perdido · pgmq · Realtime.

Conversão e perda são **sempre manuais** na V1 (item 15).

---

## L. Pontos de maior risco técnico

Em ordem de probabilidade × impacto:

1. **Webhook único na Evolution (risco #1, e é de infraestrutura, não de código).**
   A instância hoje aponta para a Edge Function `whatsapp-webhook` do CRM Maison D'Or. A Evolution v2 tem **uma URL de webhook por instância** — apontar para o projeto novo **desliga o antigo**.
   Mitigação implementada: `wa-webhook` tem espelhamento opcional (`LEGACY_WEBHOOK_URL`) que repassa o payload cru para o webhook antigo, permitindo os dois consumidores sem tocar no código do CRM antigo:
   ```
   Evolution → wa-webhook (novo) ──┬──► persiste no projeto novo
                                   └──► repassa cru para o CRM antigo
   ```
   O espelhamento é *best-effort* (falha dele não derruba a nossa resposta). **Antes de virar o webhook, confirmar se o CRM antigo ainda está em uso.** Se não estiver, não configure a variável e o caminho some. Passo a passo em `docs/evolution-webhook.md`.

2. **LID.** Contato protegido manda `@lid` sem `remoteJidAlt`. Se o LID virar telefone, o histórico é contaminado (aconteceu no CRM antigo). Mitigação: identidade é o JID, `phone = NULL`, `is_lid = true`, e o painel mostra "telefone não confirmado" desabilitando "Abrir WhatsApp". Resíduo conhecido: o mesmo contato pode aparecer como dois leads se ora vier com LID, ora resolvido — na V1 isso é resolvido manualmente e está documentado, não escondido.

3. **Auto-takeover falso.** Se a detecção de `fromMe` errar, o sistema se desliga sozinho e o lead fica sem resposta em silêncio. Mitigação: janela de graça por texto + tempo (seção G) e log explícito de toda transição para `HUMAN_TAKEOVER`.

4. **IA fugindo do escopo** (inventar preço, dar orientação clínica). Mitigação: dupla passagem da política + bloqueio determinístico de valores monetários + `HUMAN_REQUIRED` em vez de "melhor esforço".

5. **Timeout/retry da Evolution.** Se demorássemos para responder, viriam eventos repetidos. Mitigação: IA nunca no caminho do webhook + `provider_message_id UNIQUE`.

6. **Limites do Supabase Free.** Projeto pausa após 7 dias sem atividade e o pg_cron para junto. Como o webhook é o caminho primário (e não depende de cron), o impacto é baixo, mas está registrado.

7. **Formato do payload da Evolution mudar entre versões.** Mitigação: normalização isolada em um arquivo com testes (`tests/normalize_test.ts`) e `meta` guardando os campos que importam para diagnóstico.

8. **Banimento do número pelo WhatsApp.** Mitigação: rate limit por lead, delay humano antes do envio e nenhum disparo em massa (o sistema só responde quem falou primeiro).
