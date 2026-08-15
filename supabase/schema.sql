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

-- Checagem + reserva do envio num único passo atômico (trava com advisory
-- lock, escopo da transação — libera sozinha ao final da função). Antes,
-- a whatsapp-proxy fazia "select pra decidir" e só depois "insert pra
-- registrar" em dois passos separados: duas chamadas simultâneas podiam
-- ler o mesmo estado e passar juntas, furando o intervalo mínimo pensado
-- pra evitar bloqueio do número. Com a reserva feita aqui dentro (mesma
-- transação do lock), isso não é mais possível.
create or replace function public.wa_throttle_claim(
  p_telefone text,
  p_nome text,
  p_created_by text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_seg int; v_max_seg int; v_limite_hora int; v_limite_dia int;
  v_ultimo timestamptz;
  v_esperar numeric;
  v_count_hora int;
  v_count_dia int;
  v_log_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('wa_send_throttle'));

  select wa_intervalo_min_seg, wa_intervalo_max_seg, wa_limite_hora, wa_limite_dia
    into v_min_seg, v_max_seg, v_limite_hora, v_limite_dia
    from public.config where id = 1;
  v_min_seg := coalesce(v_min_seg, 20);
  v_max_seg := greatest(v_min_seg, coalesce(v_max_seg, 50));
  v_limite_hora := coalesce(v_limite_hora, 30);
  v_limite_dia := coalesce(v_limite_dia, 120);

  select max(created_at) into v_ultimo from public.wa_send_log where created_at > now() - interval '1 day';
  if v_ultimo is not null then
    v_esperar := v_min_seg + random() * (v_max_seg - v_min_seg);
    if extract(epoch from (now() - v_ultimo)) < v_esperar then
      return jsonb_build_object('ok', false, 'error', 'Aguarde antes da próxima mensagem (proteção contra bloqueio do WhatsApp).');
    end if;
  end if;

  select count(*) into v_count_hora from public.wa_send_log where created_at > now() - interval '1 hour';
  if v_count_hora >= v_limite_hora then
    return jsonb_build_object('ok', false, 'error', format('Limite de %s mensagens por hora atingido.', v_limite_hora));
  end if;

  select count(*) into v_count_dia from public.wa_send_log where created_at > now() - interval '1 day';
  if v_count_dia >= v_limite_dia then
    return jsonb_build_object('ok', false, 'error', format('Limite de %s mensagens no dia atingido.', v_limite_dia));
  end if;

  insert into public.wa_send_log (telefone, nome, created_by) values (p_telefone, p_nome, p_created_by) returning id into v_log_id;
  return jsonb_build_object('ok', true, 'log_id', v_log_id);
end;
$$;

-- Libera (apaga) uma reserva específica de wa_send_log quando o envio
-- correspondente falhou de verdade — pra não "gastar" uma vaga do limite
-- anti-bloqueio à toa. A policy de DELETE em wa_send_log é só do
-- proprietário (de propósito: ninguém da equipe deveria conseguir apagar
-- linhas livremente pra "resetar" o próprio contador) — então o
-- whatsapp-proxy, chamando como o próprio funcionário, não consegue apagar
-- direto. Esta function (security definer) abre uma exceção estreita: só
-- libera a reserva que o PRÓPRIO usuário acabou de criar (confere
-- created_by contra o e-mail do token) e só se foi criada há pouco tempo
-- (evita virar um jeito de apagar reservas antigas à vontade).
create or replace function public.wa_throttle_release(
  p_log_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deletados int;
begin
  delete from public.wa_send_log
  where id = p_log_id
    and created_by = (auth.jwt() ->> 'email')
    and created_at > now() - interval '5 minutes';
  get diagnostics v_deletados = row_count;
  return jsonb_build_object('ok', true, 'liberado', v_deletados > 0);
end;
$$;

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
-- tentativas: quantas vezes a IA já tentou gerar resposta e falhou (ex.:
-- erro de rede, chave inválida) — sem isso, uma falha sistemática gerava
-- uma chamada nova pra Anthropic a cada minuto, pra sempre, sem nunca
-- resolver (custo acidental). Depois de algumas tentativas, desiste.
alter table public.wa_inbox add column if not exists tentativas int not null default 0;
-- "processando": reserva atômica da conversa por uma execução do cron
-- (evita duas execuções sobrepostas pegarem e processarem a mesma
-- conversa duas vezes, gerando chamada dupla à IA e custo em dobro).
alter table public.wa_inbox drop constraint if exists wa_inbox_status_check;
alter table public.wa_inbox add constraint wa_inbox_status_check
  check (status in ('aguardando','processando','rascunho_pronto','enviado','descartado'));

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
-- media_path: caminho do arquivo dentro do bucket privado "wa-media" (não é
-- uma URL pública — a tela gera um link assinado e temporário na hora de
-- exibir). media_mime: tipo do arquivo (ex.: image/jpeg), usado pra escolher
-- como renderizar (imagem, vídeo, player de áudio ou link de documento).
alter table public.wa_messages add column if not exists media_path text;
alter table public.wa_messages add column if not exists media_mime text;
-- telefone_e_lid: true quando o "telefone" veio de um identificador oculto
-- do WhatsApp (JID terminado em @lid), não de um número de verdade — a
-- Evolution API já resolve isso sozinha quando consegue (usando
-- remoteJidAlt), mas quando não consegue, guardar essa marcação evita
-- tratar esse valor como se fosse um telefone confiável em qualquer tela
-- ou relatório futuro.
alter table public.wa_messages add column if not exists telefone_e_lid boolean not null default false;
alter table public.wa_inbox add column if not exists telefone_e_lid boolean not null default false;

-- ============================================================
-- STORAGE: bucket privado pra fotos/vídeos/áudios/documentos trocados no
-- WhatsApp (dado de paciente — por isso privado, nunca público). Só quem
-- está autenticado no painel consegue ler (via link assinado, temporário)
-- ou enviar arquivo pra esse bucket.
-- ============================================================
-- file_size_limit trava o tamanho direto na API de Storage (antes de
-- qualquer upload ser aceito) — sem isso, só existia um teto de 16MB no
-- navegador, que não é uma barreira de segurança de verdade (dá pra
-- chamar a API de Storage direto). 20MB dá folga sobre o limite do
-- navegador sem deixar arquivo enorme passar.
insert into storage.buckets (id, name, public, file_size_limit)
values ('wa-media', 'wa-media', false, 20971520)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "wa_media_select" on storage.objects;
create policy "wa_media_select" on storage.objects for select to authenticated
  using (bucket_id = 'wa-media');

drop policy if exists "wa_media_insert" on storage.objects;
create policy "wa_media_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'wa-media');

-- ============================================================
-- STORAGE: bucket privado "backups" — exportação semanal (JSON) das
-- tabelas mais sensíveis (feita pela function wa-backup-export, com a
-- service role — só ela grava aqui). Só o proprietário pode ler, já que
-- um export completo de conversas/leads é mais sensível que um anexo
-- avulso.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;

drop policy if exists "backups_select" on storage.objects;
create policy "backups_select" on storage.objects for select to authenticated
  using (bucket_id = 'backups' and public.is_owner());

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
-- (todo "drop policy if exists" abaixo existe só pra deixar seguro rodar
-- este arquivo inteiro de novo num banco que já rodou ele antes — sem
-- isso, "create policy" dá erro de "já existe" e trava o resto do arquivo)
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select to authenticated using (true);
drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles for insert to authenticated with check (auth.uid() = id);
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles for update to authenticated using (auth.uid() = id or public.is_owner());

-- leads / diárias / ativos / contatos / checklist / confirmações do dia:
-- toda a equipe autenticada usa no dia a dia.
drop policy if exists "leads_all" on public.leads;
create policy "leads_all" on public.leads for all to authenticated using (true) with check (true);
drop policy if exists "diarias_all" on public.diarias;
create policy "diarias_all" on public.diarias for all to authenticated using (true) with check (true);
drop policy if exists "ativos_all" on public.ativos;
create policy "ativos_all" on public.ativos for all to authenticated using (true) with check (true);
drop policy if exists "contatos_all" on public.contatos;
create policy "contatos_all" on public.contatos for all to authenticated using (true) with check (true);
drop policy if exists "checklist_state_all" on public.checklist_state;
create policy "checklist_state_all" on public.checklist_state for all to authenticated using (true) with check (true);
drop policy if exists "confirmacoes_dia_all" on public.confirmacoes_dia;
create policy "confirmacoes_dia_all" on public.confirmacoes_dia for all to authenticated using (true) with check (true);
drop policy if exists "templates_all" on public.templates;
create policy "templates_all" on public.templates for all to authenticated using (true) with check (true);
-- wa_send_log é o registro que sustenta a proteção anti-bloqueio (intervalo
-- mínimo + limites por hora/dia): todo mundo pode registrar e ler um envio,
-- mas ninguém de equipe pode apagar linhas pra "resetar" o contador — só o
-- proprietário, e mesmo assim isso não deveria ser necessário no dia a dia.
drop policy if exists "wa_send_log_all" on public.wa_send_log;
drop policy if exists "wa_send_log_select" on public.wa_send_log;
create policy "wa_send_log_select" on public.wa_send_log for select to authenticated using (true);
drop policy if exists "wa_send_log_insert" on public.wa_send_log;
create policy "wa_send_log_insert" on public.wa_send_log for insert to authenticated with check (true);
drop policy if exists "wa_send_log_delete" on public.wa_send_log;
create policy "wa_send_log_delete" on public.wa_send_log for delete to authenticated using (public.is_owner());
-- wa_inbox / wa_messages / crm_segmentados: histórico de conversa de
-- paciente — toda a equipe precisa ler/editar no dia a dia, mas só o
-- proprietário pode apagar (mesma lógica já usada em wa_send_log e
-- rotinas). Sem essa restrição, qualquer conta de equipe podia apagar
-- o histórico inteiro de um paciente sem deixar rastro.
drop policy if exists "wa_inbox_all" on public.wa_inbox;
drop policy if exists "wa_inbox_select" on public.wa_inbox;
create policy "wa_inbox_select" on public.wa_inbox for select to authenticated using (true);
drop policy if exists "wa_inbox_insert" on public.wa_inbox;
create policy "wa_inbox_insert" on public.wa_inbox for insert to authenticated with check (true);
drop policy if exists "wa_inbox_update" on public.wa_inbox;
create policy "wa_inbox_update" on public.wa_inbox for update to authenticated using (true);
drop policy if exists "wa_inbox_delete" on public.wa_inbox;
create policy "wa_inbox_delete" on public.wa_inbox for delete to authenticated using (public.is_owner());

drop policy if exists "wa_messages_all" on public.wa_messages;
drop policy if exists "wa_messages_select" on public.wa_messages;
create policy "wa_messages_select" on public.wa_messages for select to authenticated using (true);
drop policy if exists "wa_messages_insert" on public.wa_messages;
create policy "wa_messages_insert" on public.wa_messages for insert to authenticated with check (true);
drop policy if exists "wa_messages_update" on public.wa_messages;
create policy "wa_messages_update" on public.wa_messages for update to authenticated using (true);
drop policy if exists "wa_messages_delete" on public.wa_messages;
create policy "wa_messages_delete" on public.wa_messages for delete to authenticated using (public.is_owner());

-- crm_segmentados: diferente de wa_inbox/wa_messages, aqui a equipe toda
-- já usa um botão "Remover do CRM" no dia a dia (index.html) — restringir
-- a exclusão só ao proprietário quebraria esse fluxo sem aviso claro.
-- Mantido como estava.
drop policy if exists "crm_segmentados_all" on public.crm_segmentados;
create policy "crm_segmentados_all" on public.crm_segmentados for all to authenticated using (true) with check (true);

-- rotinas: todo mundo lê; só o proprietário cria/edita/exclui.
drop policy if exists "rotinas_select" on public.rotinas;
create policy "rotinas_select" on public.rotinas for select to authenticated using (true);
drop policy if exists "rotinas_write" on public.rotinas;
create policy "rotinas_write" on public.rotinas for insert to authenticated with check (public.is_owner());
drop policy if exists "rotinas_update" on public.rotinas;
create policy "rotinas_update" on public.rotinas for update to authenticated using (public.is_owner());
drop policy if exists "rotinas_delete" on public.rotinas;
create policy "rotinas_delete" on public.rotinas for delete to authenticated using (public.is_owner());

-- config: todo mundo lê (metas aparecem no checklist); só o proprietário edita.
drop policy if exists "config_select" on public.config;
create policy "config_select" on public.config for select to authenticated using (true);
drop policy if exists "config_update" on public.config;
create policy "config_update" on public.config for update to authenticated using (public.is_owner());

-- ia_prompt: só o proprietário lê e edita.
drop policy if exists "ia_prompt_select" on public.ia_prompt;
create policy "ia_prompt_select" on public.ia_prompt for select to authenticated using (public.is_owner());
drop policy if exists "ia_prompt_update" on public.ia_prompt;
create policy "ia_prompt_update" on public.ia_prompt for update to authenticated using (public.is_owner());
