set search_path = dental_leads, public, extensions;

-- ============================================================================
-- Correção: schema dental_leads criado sem as permissões básicas que o
-- schema `public` recebe automaticamente do Postgres/Supabase. Sem isso,
-- toda chamada das Edge Functions (via service_role) e do painel (via
-- anon/authenticated) falha com "permission denied for schema dental_leads",
-- mesmo com os grants por objeto já corretos nas migrations anteriores.
-- ============================================================================

grant usage on schema dental_leads to anon, authenticated, service_role;

-- service_role (usado pelas Edge Functions) precisa de acesso total, igual
-- teria em public por padrão.
grant all on all tables in schema dental_leads to service_role;
grant all on all sequences in schema dental_leads to service_role;
grant execute on all functions in schema dental_leads to service_role;

-- authenticated (painel web) mantém só o que as migrations anteriores já
-- concediam por tabela; aqui só garantimos que objetos futuros herdem o
-- mesmo padrão sem precisar de nova migration de grant.
alter default privileges in schema dental_leads
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema dental_leads
  grant execute on functions to service_role;
