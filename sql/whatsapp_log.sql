-- Rode este script uma vez no Supabase: Painel do Supabase > SQL Editor > New query > cole e clique em "Run".
-- Ele cria a UNICA tabela nova desta fase 1: whatsapp_log.
-- Serve so para registrar mensagens que entraram (webhook) e mensagens que saíram (envio manual de template).

create table if not exists public.whatsapp_log (
  id uuid primary key default gen_random_uuid(),
  direcao text not null check (direcao in ('entrada', 'saida')),
  telefone text not null,
  texto text,
  wamid text,
  status text,
  criado_em timestamptz not null default now()
);

-- Indice para facilitar buscas por telefone (ex: ver historico de um paciente).
create index if not exists whatsapp_log_telefone_idx on public.whatsapp_log (telefone);

-- Habilita Row Level Security. Como o servidor usa a chave "service_role" (que ignora RLS),
-- isso apenas garante que ninguem consiga ler/escrever essa tabela direto pelo painel web
-- ou por chaves publicas (anon) sem uma politica explicita.
alter table public.whatsapp_log enable row level security;
