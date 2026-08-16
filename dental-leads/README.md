# Automação de leads odontológicos via WhatsApp

Sistema enxuto que faz três coisas, e só três:

1. recebe mensagens de leads pelo WhatsApp (via Evolution API já existente);
2. responde automaticamente com IA **quando a política permite**;
3. move o lead no funil conforme a conversa evolui.

**Não é um CRM.** Não tem chat interno, mídia, campanha, agenda, prontuário
nem relatório. Se algo não é necessário para *receber → analisar → responder
com segurança → atualizar o funil*, não está aqui.

> Projeto separado do CRM Maison D'Or que vive na raiz deste repositório.
> Nenhum arquivo, tabela ou função daquele projeto é lido ou alterado por este.
> Leia `ARQUITETURA.md` antes de mexer em qualquer coisa aqui.

```
WhatsApp → Evolution API → wa-webhook → Postgres → fila → lead-worker
                                                            │
                        Policy Engine → IA → Policy Engine → rate limit
                                                            │
                                              Evolution sendText → lead
```

Princípio: **a IA pensa, o servidor decide e executa.** A IA nunca envia nada
por conta própria — toda saída passa por `evaluatePostPolicy()` e
`canSendMessage()`.

## O que é preciso ter antes

- Evolution API rodando com um número conectado (já existe — **não instalar
  outra**);
- projeto Supabase novo (Free serve);
- chave de API de um provedor de IA (Anthropic por padrão);
- Supabase CLI (`npm i -g supabase`).

## Deploy em 6 passos

### 1. Banco

```bash
cd dental-leads
supabase link --project-ref <PROJECT_REF>
supabase db push
```

Isso cria as 3 tabelas de aplicação (`leads`, `messages`,
`automation_decisions`), a tabela de fila (`jobs`), as RPCs transacionais e o
RLS.

### 2. Secrets

```bash
cp .env.example .env    # preencha os valores; .env NÃO vai para o git
supabase secrets set --env-file .env
```

### 3. Edge Functions

```bash
supabase functions deploy wa-webhook  --no-verify-jwt
supabase functions deploy lead-worker --no-verify-jwt
```

`--no-verify-jwt` é proposital: quem chama essas functions é a Evolution API e
o cron, não um usuário logado. A proteção é o secret em header
(`x-webhook-secret` / `x-worker-secret`), validado com comparação de tempo
constante.

### 4. Rede de segurança da fila (opcional, recomendada)

Edite `supabase/migrations/0002_cron.sql` substituindo `<PROJECT_REF>` e
`<WORKER_SECRET>`, e rode o arquivo no SQL Editor. O caminho principal
(webhook → worker) funciona sem isso; o cron só cobre falhas de disparo.

### 5. Webhook da Evolution

**Leia `docs/evolution-webhook.md` antes.** A instância hoje aponta para o CRM
antigo, e a Evolution aceita uma URL por instância — trocar sem verificar
desliga o outro sistema silenciosamente.

### 6. Painel

1. Supabase → Authentication → crie o usuário da clínica (e-mail + senha).
   Desligue "Enable signup" para não permitir cadastro aberto.
2. Preencha `web/config.js` com a URL do projeto e a **anon key**
   (nunca a service role).
3. Publique: Settings → Pages → branch `main`, pasta `/` (raiz). O painel fica
   em `https://<usuario>.github.io/<repo>/dental-leads/web/`.

## Como operar

| Situação | O que acontece |
|---|---|
| Lead manda texto comercial | IA responde e o lead avança no funil |
| Lead pergunta preço | IA acolhe, **não cita valor**; se citar, a resposta é bloqueada |
| Lead fala de dor/sangramento/remédio | IA não responde; card fica ⚠ Humano necessário |
| Lead manda foto/áudio/vídeo/documento | vira caso humano; lead recebe só a frase neutra |
| Alguém responde pelo celular | automação entra em `HUMAN_TAKEOVER` e para |
| Voltar a automação | botão "Ligar IA" no drawer (sempre manual) |
| Marcar convertido/perdido | sempre manual, pelo painel |

## Auditoria

"Por que a IA respondeu isso?" tem resposta em SQL:

```sql
select created_at, intent, risk, confidence, action, reason, reply_sent,
       stage_before, stage_after
  from automation_decisions
 where lead_id = '<uuid>'
 order by created_at desc;
```

Fila travada:

```sql
select * from jobs where status in ('PENDING','FAILED') order by created_at desc;
```

## Trocar de modelo ou provedor

```bash
supabase secrets set AI_PROVIDER=openai AI_MODEL=<modelo> AI_API_KEY=<chave> AI_BASE_URL=<url>
```

Zero mudança de código: `_shared/ai.ts` fala Anthropic (tool com schema
forçado) ou qualquer API compatível com OpenAI (`response_format: json_schema`).

## Testes

```bash
deno test --allow-env dental-leads/tests/
```

Cobrem o que quebra na vida real: normalização de LID e wrappers do Baileys,
descarte de grupo/status/broadcast, política verde/amarelo/vermelho, bloqueio
de preço inventado e de conteúdo clínico, rate limit e regras de funil.

## Limites conhecidos da V1

Estão listados, com mitigação, em `ARQUITETURA.md` seção L. Os três que mais
importam no dia a dia:

1. o webhook da Evolution é único por instância (ver `docs/evolution-webhook.md`);
2. contato protegido por LID pode aparecer como lead sem telefone — e, em caso
   raro, duplicado. É resolvido manualmente, de propósito: inventar número é
   pior;
3. projeto Supabase Free pausa após 7 dias sem atividade, o que também pausa o
   cron de segurança.
