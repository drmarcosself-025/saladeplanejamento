# Apontar o webhook da Evolution sem quebrar o CRM antigo

## O problema, em uma frase

A Evolution API v2 aceita **uma URL de webhook por instância**. A instância que
já está rodando hoje aponta para a Edge Function `whatsapp-webhook` do CRM
Maison D'Or. Trocar essa URL pelo projeto novo **desliga o CRM antigo na
hora** — sem erro, sem aviso: as mensagens simplesmente param de chegar lá.

Por isso: **verifique antes de trocar.**

## Passo 1 — descobrir para onde o webhook aponta hoje

```bash
curl -s "$EVOLUTION_API_URL/webhook/find/$EVOLUTION_INSTANCE" \
  -H "apikey: $EVOLUTION_API_KEY"
```

A resposta traz a `url` configurada e os eventos habilitados. Guarde essa URL:
ela é o valor de `LEGACY_WEBHOOK_URL` se você decidir manter os dois sistemas.

## Passo 2 — decidir entre dois cenários

### Cenário A — o CRM antigo não é mais usado

Nada a preservar. Deixe `LEGACY_WEBHOOK_URL` vazio e vá para o passo 3.

### Cenário B — os dois precisam funcionar ao mesmo tempo

O `wa-webhook` deste projeto espelha o payload cru para o webhook antigo:

```
Evolution ──► wa-webhook (novo) ──┬──► persiste no projeto novo
                                  └──► repassa o payload cru para o CRM antigo
```

Configure o secret do projeto novo com a URL antiga **completa** (incluindo o
`?secret=` que o CRM antigo espera na query string):

```bash
supabase secrets set LEGACY_WEBHOOK_URL="https://<projeto-antigo>.supabase.co/functions/v1/whatsapp-webhook?secret=<secret-antigo>"
```

Duas coisas importantes sobre o espelhamento:

- é **best-effort**: se o repasse falhar, isso é registrado no log
  (`legacy_espelho_falhou`) mas não invalida a persistência daqui. O CRM antigo
  pode perder uma mensagem em caso de instabilidade;
- nenhuma linha de código do CRM antigo é alterada. Ele continua recebendo
  exatamente o mesmo formato de payload que recebe hoje.

Se em algum momento o CRM antigo precisar de garantia de entrega igual à do
projeto novo, o caminho certo deixa de ser espelhamento e passa a ser um
roteador dedicado na frente dos dois — mas isso só se justifica se os dois
sistemas forem críticos ao mesmo tempo, o que não é o caso na migração.

## Passo 3 — apontar o webhook para o projeto novo

```bash
curl -X POST "$EVOLUTION_API_URL/webhook/set/$EVOLUTION_INSTANCE" \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://<PROJECT_REF>.supabase.co/functions/v1/wa-webhook",
      "headers": { "x-webhook-secret": "<WEBHOOK_SECRET>" },
      "byEvents": false,
      "base64": false,
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

Só `MESSAGES_UPSERT` é necessário. Habilitar mais eventos só gera tráfego que
o `wa-webhook` vai descartar.

Se a sua versão da Evolution não suportar `headers` na configuração do webhook,
use a URL com o secret na query string — o `wa-webhook` aceita os dois:

```
https://<PROJECT_REF>.supabase.co/functions/v1/wa-webhook?secret=<WEBHOOK_SECRET>
```

O header é preferível: query string aparece em log de proxy e histórico com
muito mais facilidade.

## Passo 4 — confirmar

1. Mande uma mensagem de um número que não seja o da clínica.
2. Supabase → Edge Functions → `wa-webhook` → Logs: procure `webhook_ok`.
3. `select * from leads order by created_at desc limit 1;`
4. Se estiver no cenário B, confira também que a mensagem apareceu no CRM
   antigo (log `legacy_espelhado`).

## Como voltar atrás

Reaponte o webhook para a URL antiga com o mesmo comando do passo 3. Nenhum
dado do projeto novo é perdido — ele só para de receber eventos.
