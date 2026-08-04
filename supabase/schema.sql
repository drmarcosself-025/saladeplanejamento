-- Maison D'Or — schema do banco (Supabase)
-- Rode este arquivo inteiro no SQL Editor do seu projeto Supabase.
-- Depois, cole a Project URL e a anon key no topo do index.html.

create extension if not exists pgcrypto;

-- ============================================================
-- PROFILES (uma linha por usuário autenticado)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  role text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now()
);

-- a primeira conta criada no sistema vira proprietária automaticamente
create or replace function public.set_first_profile_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.profiles) = 0 then
    new.role := 'owner';
  else
    new.role := coalesce(new.role, 'staff');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_first_profile_owner on public.profiles;
create trigger trg_set_first_profile_owner
  before insert on public.profiles
  for each row execute function public.set_first_profile_owner();

create or replace function public.is_owner()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  );
$$;

-- Trava de segurança: a policy "profiles_update" abaixo permite que cada
-- pessoa edite a própria linha (pra poder corrigir o nome, por exemplo),
-- mas isso sozinho deixaria qualquer conta de equipe se auto-promover a
-- "owner" direto pelo console do navegador. Este gatilho reverte qualquer
-- mudança de "role" feita por quem não é proprietário.
create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.role <> OLD.role and not public.is_owner() then
    NEW.role := OLD.role;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_prevent_role_self_escalation on public.profiles;
create trigger trg_prevent_role_self_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();

-- ============================================================
-- LEADS
-- ============================================================
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text,
  procedimento text,
  origem text not null default 'Lead interno' check (origem in ('Lead interno', 'Lead próprio')),
  data date not null default current_date,
  responsavel text,
  status text not null default 'Novo',
  compareceu text,
  fechou text,
  valor_orcamento numeric,
  valor_recebido numeric,
  motivo_perda text,
  obs text,
  data_ultimo_contato date,
  data_proxima_acao date,
  atividades jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by text
);

-- ============================================================
-- DIÁRIAS (fechamento / folha de pagamento)
-- ============================================================
create table if not exists public.diarias (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  entrada time,
  saida time,
  registrado_por text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ATIVOS (reativação de pacientes antigos)
-- ============================================================
create table if not exists public.ativos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text,
  ultima_visita date,
  proximo_contato date,
  status text not null default 'Ativo' check (status in ('Ativo', 'Contatado', 'Reagendado', 'Perdido')),
  obs text,
  adicionado_por text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- CONTATOS
-- ============================================================
create table if not exists public.contatos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text,
  cidade text,
  estado text,
  categoria text,
  origem text,
  adicionado_por text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- TEMPLATES (modelos de mensagem)
-- ============================================================
create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  categoria text,
  titulo text not null,
  texto text not null,
  criado_por text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ROTINAS
-- ============================================================
create table if not exists public.rotinas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  gatilho text,
  acao text,
  ativo boolean not null default true,
  criado_por text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- CONFIG (linha única, id = 1)
-- ============================================================
create table if not exists public.config (
  id int primary key default 1,
  diaria numeric not null default 120,
  almoco numeric not null default 30,
  com_interno numeric not null default 5,
  com_proprio numeric not null default 10,
  lim_interno numeric not null default 150,
  lim_proprio numeric not null default 250,
  bonus numeric not null default 10,
  meta_ag_dia int not null default 3,
  meta_ag_semana int not null default 12,
  meta_vd_mes int not null default 10,
  wa_intervalo_min_seg int not null default 20,
  wa_intervalo_max_seg int not null default 50,
  wa_limite_hora int not null default 30,
  wa_limite_dia int not null default 120,
  wa_silencio_seg int not null default 12,
  wa_keywords text not null default 'agendar,agendamento,consulta,avaliação,avaliacao,quanto custa,valor,preço,preco,marcar,interessad,orçamento,orcamento'
);
-- garante as colunas novas mesmo em bancos que já rodaram este arquivo antes
alter table public.config add column if not exists wa_intervalo_min_seg int not null default 20;
alter table public.config add column if not exists wa_intervalo_max_seg int not null default 50;
alter table public.config add column if not exists wa_limite_hora int not null default 30;
alter table public.config add column if not exists wa_limite_dia int not null default 120;
alter table public.config add column if not exists wa_silencio_seg int not null default 12;
alter table public.config add column if not exists wa_keywords text not null default 'agendar,agendamento,consulta,avaliação,avaliacao,quanto custa,valor,preço,preco,marcar,interessad,orçamento,orcamento';
insert into public.config (id) values (1) on conflict (id) do nothing;

-- ============================================================
-- IA_PROMPT (linha única, id = 1 — rascunho do proprietário)
-- ============================================================
create table if not exists public.ia_prompt (
  id int primary key default 1,
  texto text not null default ''
);
insert into public.ia_prompt (id) values (1) on conflict (id) do nothing;

-- ============================================================
-- CHECKLIST_STATE (uma linha por dia)
-- ============================================================
create table if not exists public.checklist_state (
  data date primary key,
  state jsonb not null default '{}'::jsonb
);

-- ============================================================
-- CONFIRMACOES_DIA (pacientes do dia a confirmar, uma linha por dia)
-- ============================================================
create table if not exists public.confirmacoes_dia (
  data date primary key,
  pacientes jsonb not null default '[]'::jsonb
);

-- ============================================================
-- WA_SEND_LOG (registro de cada mensagem de WhatsApp disparada pelo
-- painel, usado pra aplicar o intervalo mínimo e os limites por
-- hora/dia contra bloqueio do número — política anti-spam)
-- ============================================================
create table if not exists public.wa_send_log (
  id uuid primary key default gen_random_uuid(),
  telefone text,
  nome text,
  created_at timestamptz not null default now(),
  created_by text
);
create index if not exists wa_send_log_created_at_idx on public.wa_send_log (created_at desc);

-- ============================================================
-- WA_INBOX (conversas recebidas pelo WhatsApp, aguardando ou já com
-- rascunho de resposta da IA pronto pra revisão humana)
-- ============================================================
create table if not exists public.wa_inbox (
  id uuid primary key default gen_random_uuid(),
  telefone text not null,
  nome_contato text,
  mensagens jsonb not null default '[]'::jsonb,
  ultima_mensagem_em timestamptz not null default now(),
  status text not null default 'aguardando' check (status in ('aguardando','rascunho_pronto','enviado','descartado')),
  rascunho_resposta text,
  palavras_chave_detectadas text[],
  lead_sugerido boolean not null default false,
  lead_id uuid references public.leads(id) on delete set null,
  processado_em timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wa_inbox_status_idx on public.wa_inbox (status);
create index if not exists wa_inbox_telefone_idx on public.wa_inbox (telefone);

-- ============================================================
-- WA_MESSAGES (histórico real de todas as mensagens de WhatsApp,
-- recebidas ou enviadas — fonte de dados da central de conversas.
-- Diferente do wa_inbox, que só guarda o lote mais recente aguardando
-- resposta da IA, esta tabela nunca é limpa — é o histórico completo.)
-- ============================================================
create table if not exists public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  telefone text not null,
  nome_contato text,
  direcao text not null check (direcao in ('recebida','enviada')),
  texto text not null,
  created_at timestamptz not null default now(),
  created_by text
);
-- wa_message_id: o ID da mensagem de verdade no WhatsApp (item.key.id na
-- Evolution API), usado pra nunca duplicar a mesma mensagem caso o webhook
-- dispare mais de uma vez pro mesmo evento (acontece na prática).
-- tipo: texto/imagem/video/outro — guardado mesmo sem exibir ainda, pra já
-- ficar disponível quando anexos forem suportados na tela.
alter table public.wa_messages add column if not exists wa_message_id text;
alter table public.wa_messages add column if not exists tipo text not null default 'texto';
-- Precisa ser uma constraint "cheia" (não um índice parcial) pra funcionar
-- com ON CONFLICT — no Postgres, uma coluna nullable com unique constraint
-- já permite várias linhas com wa_message_id nulo sem problema nenhum, então
-- não precisava do "where ... is not null" que eu tinha colocado antes.
drop index if exists public.wa_messages_wa_message_id_idx;
alter table public.wa_messages drop constraint if exists wa_messages_wa_message_id_key;
alter table public.wa_messages add constraint wa_messages_wa_message_id_key unique (wa_message_id);
create index if not exists wa_messages_telefone_idx on public.wa_messages (telefone, created_at desc);

-- ============================================================
-- CRM_SEGMENTADOS (mapa próprio de contatos segmentados pelo WhatsApp —
-- separado do Funil/Leads. Alimentado automaticamente quando a IA detecta
-- palavra-chave numa conversa, e também editável manualmente pela equipe.)
-- ============================================================
create table if not exists public.crm_segmentados (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text,
  etapa text not null default 'Detectado' check (etapa in (
    'Detectado','Lead frio','Virou lead','Lead interessado',
    'Proposta enviada','Ficou de fechar','Não agendou ainda'
  )),
  palavras_chave text[],
  lead_id uuid references public.leads(id) on delete set null,
  obs text,
  criado_por text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_segmentados_etapa_idx on public.crm_segmentados (etapa);
create index if not exists crm_segmentados_telefone_idx on public.crm_segmentados (telefone);

-- ============================================================
-- PERMISSÕES — qualquer usuário autenticado pode ler/gravar
-- (o controle fino é feito pelas policies de RLS abaixo)
-- ============================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles enable row level security;
alter table public.leads enable row level security;
alter table public.diarias enable row level security;
alter table public.ativos enable row level security;
alter table public.contatos enable row level security;
alter table public.templates enable row level security;
alter table public.rotinas enable row level security;
alter table public.config enable row level security;
alter table public.ia_prompt enable row level security;
alter table public.checklist_state enable row level security;
alter table public.confirmacoes_dia enable row level security;
alter table public.wa_send_log enable row level security;
alter table public.wa_inbox enable row level security;
alter table public.wa_messages enable row level security;
alter table public.crm_segmentados enable row level security;

-- profiles: todo mundo autenticado vê a equipe; cada um cria/edita o próprio
-- perfil; só o proprietário pode mudar o "role" de outra pessoa.
create policy "profiles_select" on public.profiles for select to authenticated using (true);
create policy "profiles_insert_self" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update to authenticated using (auth.uid() = id or public.is_owner());

-- leads / diárias / ativos / contatos / checklist / confirmações do dia:
-- toda a equipe autenticada usa no dia a dia.
create policy "leads_all" on public.leads for all to authenticated using (true) with check (true);
create policy "diarias_all" on public.diarias for all to authenticated using (true) with check (true);
create policy "ativos_all" on public.ativos for all to authenticated using (true) with check (true);
create policy "contatos_all" on public.contatos for all to authenticated using (true) with check (true);
create policy "checklist_state_all" on public.checklist_state for all to authenticated using (true) with check (true);
create policy "confirmacoes_dia_all" on public.confirmacoes_dia for all to authenticated using (true) with check (true);
create policy "templates_all" on public.templates for all to authenticated using (true) with check (true);
-- wa_send_log é o registro que sustenta a proteção anti-bloqueio (intervalo
-- mínimo + limites por hora/dia): todo mundo pode registrar e ler um envio,
-- mas ninguém de equipe pode apagar linhas pra "resetar" o contador — só o
-- proprietário, e mesmo assim isso não deveria ser necessário no dia a dia.
-- (o "drop... if exists" deixa seguro rodar este arquivo de novo num banco
-- que já tinha a policy antiga, mais permissiva)
drop policy if exists "wa_send_log_all" on public.wa_send_log;
create policy "wa_send_log_select" on public.wa_send_log for select to authenticated using (true);
create policy "wa_send_log_insert" on public.wa_send_log for insert to authenticated with check (true);
create policy "wa_send_log_delete" on public.wa_send_log for delete to authenticated using (public.is_owner());
create policy "wa_inbox_all" on public.wa_inbox for all to authenticated using (true) with check (true);
create policy "wa_messages_all" on public.wa_messages for all to authenticated using (true) with check (true);
create policy "crm_segmentados_all" on public.crm_segmentados for all to authenticated using (true) with check (true);

-- rotinas: todo mundo lê; só o proprietário cria/edita/exclui.
create policy "rotinas_select" on public.rotinas for select to authenticated using (true);
create policy "rotinas_write" on public.rotinas for insert to authenticated with check (public.is_owner());
create policy "rotinas_update" on public.rotinas for update to authenticated using (public.is_owner());
create policy "rotinas_delete" on public.rotinas for delete to authenticated using (public.is_owner());

-- config: todo mundo lê (metas aparecem no checklist); só o proprietário edita.
create policy "config_select" on public.config for select to authenticated using (true);
create policy "config_update" on public.config for update to authenticated using (public.is_owner());

-- ia_prompt: só o proprietário lê e edita.
create policy "ia_prompt_select" on public.ia_prompt for select to authenticated using (public.is_owner());
create policy "ia_prompt_update" on public.ia_prompt for update to authenticated using (public.is_owner());
