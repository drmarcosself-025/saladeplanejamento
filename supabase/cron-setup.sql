-- Agendador que processa a caixa de entrada do WhatsApp a cada minuto.
--
-- Diferente do schema.sql, este arquivo tem espaço pra colar duas chaves
-- sensíveis. Por isso ele é um arquivo separado: rode só depois de:
--   1. Ter publicado as duas functions (whatsapp-webhook e
--      whatsapp-process-inbox);
--   2. Ter pego sua chave em Project Settings → API → "service_role"
--      (ou, em projetos com o sistema novo de chaves, a "secret key"
--      em Project Settings → API Keys → Secret keys) — NÃO é a
--      publishable key que está no index.html;
--   3. Ter definido uma senha sua (qualquer texto, à sua escolha) como
--      segredo CRON_SECRET na function whatsapp-process-inbox (Project
--      Settings → Edge Functions → whatsapp-process-inbox → Secrets).
--      Essa senha é a única coisa que impede qualquer pessoa na internet
--      de chamar essa function direto (o que geraria custo na sua conta
--      da Anthropic e criaria leads falsos) — sem ela, a function fica
--      sem nenhuma autenticação, já que o "Enforce JWT Verification"
--      dela também precisa ficar desligado (quem chama é o agendador,
--      não um usuário logado).
--
-- Troque SUA_SERVICE_ROLE_KEY_AQUI e SUA_CRON_SECRET_AQUI abaixo pelos
-- valores de verdade antes de rodar.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'wa-process-inbox',
  '* * * * *', -- a cada minuto (pg_cron não tem granularidade menor que isso)
  $$
  select net.http_post(
    url := 'https://ftywkcxlyxaeihflfalv.supabase.co/functions/v1/whatsapp-process-inbox',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer SUA_SERVICE_ROLE_KEY_AQUI',
      'x-cron-secret', 'SUA_CRON_SECRET_AQUI'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Pra conferir se o agendamento foi criado:
-- select * from cron.job;

-- Pra remover (se precisar refazer):
-- select cron.unschedule('wa-process-inbox');
