-- ============================================================================
-- Automação de leads odontológicos via WhatsApp — schema inicial (V1)
--
-- 3 tabelas de aplicação (leads, messages, automation_decisions)
-- + 1 tabela de infraestrutura (jobs = fila).
--
-- Toda escrita crítica passa por RPC transacional. O webhook só devolve
-- sucesso para a Evolution depois que a transação inteira fechou.
-- ============================================================================

-- Schema isolado: convive no mesmo projeto Supabase de outros sistemas
-- (CRM antigo em `public`) sem colidir nome de tabela/tipo/função nenhum.
create schema if not exists dental_leads;
set search_path = dental_leads, public, extensions;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
do $$ begin
  create type lead_stage as enum ('NEW','CONVERSATION','INTEREST','SCHEDULING','CONVERTED','LOST');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Derivado de stage por trigger. Existe só para o painel filtrar rápido;
  -- não é uma segunda fonte de verdade.
  create type lead_status as enum ('OPEN','CLOSED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type automation_status as enum ('ACTIVE','HUMAN_REQUIRED','HUMAN_TAKEOVER','PAUSED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_direction as enum ('IN','OUT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sender_type as enum ('LEAD','AI','HUMAN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type risk_level as enum ('LOW','MEDIUM','HIGH');
exception when duplicate_object then null; end $$;

do $$ begin
  create type decision_action as enum ('AUTO_REPLY','HUMAN','IGNORE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status as enum ('PENDING','RUNNING','DONE','FAILED');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- leads
--
-- A identidade é o JID do WhatsApp (whatsapp_id), NUNCA o telefone. Contato
-- protegido chega como "<codigo>@lid" e o número real pode simplesmente não
-- existir — nesse caso phone fica NULL e is_lid = true. Um código LID jamais
-- é gravado em phone (esse erro contamina histórico e segmentação).
-- ---------------------------------------------------------------------------
create table if not exists dental_leads.leads (
  id                   uuid primary key default gen_random_uuid(),
  whatsapp_id          text not null unique,
  phone                text,
  is_lid               boolean not null default false,
  name                 text,
  stage                lead_stage not null default 'NEW',
  status               lead_status not null default 'OPEN',
  treatment_interest   text,
  automation_status    automation_status not null default 'ACTIVE',
  needs_human          boolean not null default false,
  human_reason         text,
  conversation_summary text,
  last_message_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists leads_stage_idx on dental_leads.leads (stage, last_message_at desc);
create index if not exists leads_needs_human_idx on dental_leads.leads (needs_human) where needs_human;

-- ---------------------------------------------------------------------------
-- messages
--
-- Memória operacional e auditoria — não é histórico navegável de WhatsApp Web.
-- provider_message_id UNIQUE é a garantia de idempotência de ponta a ponta:
-- webhook repetido não gera segunda resposta nem segundo movimento de funil.
-- ---------------------------------------------------------------------------
create table if not exists dental_leads.messages (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid not null references dental_leads.leads(id) on delete cascade,
  provider_message_id text unique,
  direction           message_direction not null,
  sender_type         sender_type not null,
  message_type        text not null default 'TEXT',
  text                text,
  processed           boolean not null default false,
  -- Apenas os campos de normalização que já causaram problema em produção
  -- (remoteJid, remoteJidAlt, participant, wrapper, pushName). Nunca o
  -- payload inteiro.
  meta                jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists messages_lead_created_idx on dental_leads.messages (lead_id, created_at desc);
create index if not exists messages_outbound_idx
  on dental_leads.messages (lead_id, created_at desc)
  where direction = 'OUT';

-- ---------------------------------------------------------------------------
-- automation_decisions — responde "por que a IA respondeu isso?"
-- ---------------------------------------------------------------------------
create table if not exists dental_leads.automation_decisions (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references dental_leads.leads(id) on delete cascade,
  message_id   uuid references dental_leads.messages(id) on delete set null,
  intent       text,
  risk         risk_level,
  confidence   numeric(4,3),
  action       decision_action not null,
  stage_before lead_stage,
  stage_after  lead_stage,
  reason       text,
  reply_sent   boolean not null default false,
  ai_raw       jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists decisions_lead_idx on dental_leads.automation_decisions (lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- jobs — fila (infraestrutura, não é tabela de aplicação)
--
-- message_id UNIQUE: a mesma mensagem nunca gera dois jobs.
-- ---------------------------------------------------------------------------
create table if not exists dental_leads.jobs (
  id              bigserial primary key,
  lead_id         uuid not null references dental_leads.leads(id) on delete cascade,
  message_id      uuid not null unique references dental_leads.messages(id) on delete cascade,
  status          job_status not null default 'PENDING',
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  locked_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists jobs_ready_idx
  on dental_leads.jobs (next_attempt_at)
  where status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Triggers utilitários
-- ---------------------------------------------------------------------------
create or replace function dental_leads.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- status é derivado de stage: um lead só está fechado quando foi convertido
-- ou perdido. Mantido por trigger para não existir divergência possível.
create or replace function dental_leads.sync_lead_status()
returns trigger language plpgsql as $$
begin
  new.status := case when new.stage in ('CONVERTED','LOST') then 'CLOSED' else 'OPEN' end;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists leads_sync_status on dental_leads.leads;
create trigger leads_sync_status
  before insert or update on dental_leads.leads
  for each row execute function dental_leads.sync_lead_status();

drop trigger if exists jobs_touch on dental_leads.jobs;
create trigger jobs_touch
  before update on dental_leads.jobs
  for each row execute function dental_leads.touch_updated_at();

-- ============================================================================
-- RPC 1 — ingest_inbound_message
--
-- Uma transação: upsert do lead + insert da mensagem + enfileiramento.
-- O webhook só responde 200 depois que isto retornou com sucesso.
-- ============================================================================
create or replace function dental_leads.ingest_inbound_message(
  p_whatsapp_id         text,
  p_phone               text,
  p_is_lid              boolean,
  p_name                text,
  p_provider_message_id text,
  p_message_type        text,
  p_text                text,
  p_meta                jsonb,
  p_occurred_at         timestamptz,
  p_needs_human         boolean default false,
  p_human_reason        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead        dental_leads.leads%rowtype;
  v_message_id  uuid;
  v_enqueue     boolean;
  v_job_id      bigint;
begin
  -- Upsert do lead. Regras de proteção de dado:
  --   * um telefone real já conhecido nunca é rebaixado para NULL;
  --   * quando o número real aparece, a marca de LID é limpa;
  --   * o nome só é sobrescrito por um valor não vazio.
  insert into dental_leads.leads (whatsapp_id, phone, is_lid, name, last_message_at)
  values (
    p_whatsapp_id,
    nullif(p_phone, ''),
    coalesce(p_is_lid, false),
    nullif(p_name, ''),
    coalesce(p_occurred_at, now())
  )
  on conflict (whatsapp_id) do update set
    phone           = coalesce(nullif(excluded.phone, ''), leads.phone),
    is_lid          = case
                        when nullif(excluded.phone, '') is not null then false
                        else leads.is_lid
                      end,
    name            = coalesce(nullif(excluded.name, ''), leads.name),
    last_message_at = greatest(
                        coalesce(leads.last_message_at, to_timestamp(0)),
                        coalesce(excluded.last_message_at, now())
                      )
  returning * into v_lead;

  -- A automação só roda para lead em ACTIVE. Um lead em PAUSED,
  -- HUMAN_TAKEOVER ou HUMAN_REQUIRED não gera job — logo, não gera custo de
  -- IA nem resposta automática.
  --
  -- Mídia chega com p_needs_human = true e ainda assim gera job: quem faz a
  -- transição para HUMAN_REQUIRED é o worker, depois de mandar a resposta
  -- neutra pré-autorizada e registrar a decisão. Se a transição fosse feita
  -- aqui, o próprio worker se veria bloqueado e o lead ficaria sem nenhum
  -- retorno.
  v_enqueue := v_lead.automation_status = 'ACTIVE';

  insert into dental_leads.messages (
    lead_id, provider_message_id, direction, sender_type,
    message_type, text, processed, meta, created_at
  )
  values (
    v_lead.id, p_provider_message_id, 'IN', 'LEAD',
    coalesce(p_message_type, 'TEXT'), p_text, not v_enqueue, p_meta,
    coalesce(p_occurred_at, now())
  )
  on conflict (provider_message_id) do nothing
  returning id into v_message_id;

  -- Mensagem repetida (retry da Evolution, evento duplicado): não responder
  -- de novo, não duplicar, não mover o lead outra vez.
  if v_message_id is null then
    return jsonb_build_object(
      'duplicate', true,
      'lead_id', v_lead.id,
      'enqueued', false
    );
  end if;

  if coalesce(p_needs_human, false) then
    update dental_leads.leads
       set needs_human  = true,
           human_reason = coalesce(p_human_reason, human_reason)
     where id = v_lead.id;
  end if;

  if v_enqueue then
    insert into dental_leads.jobs (lead_id, message_id)
    values (v_lead.id, v_message_id)
    on conflict (message_id) do nothing
    returning id into v_job_id;
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'lead_id', v_lead.id,
    'message_id', v_message_id,
    'enqueued', v_job_id is not null,
    'job_id', v_job_id
  );
end $$;

-- ============================================================================
-- RPC 2 — ingest_outbound_event (detecção de human takeover)
--
-- Chega um evento fromMe. Três casos:
--   1. já conhecemos o provider_message_id  → é a nossa própria mensagem;
--   2. bate com um envio nosso ainda sem id (janela de corrida)  → vincula;
--   3. nenhum dos dois  → um humano respondeu pelo celular  → HUMAN_TAKEOVER.
--
-- Sem o caso 2 o sistema se auto-desligaria a cada resposta que ele mesmo
-- envia, porque a Evolution às vezes entrega o eco do fromMe antes de
-- gravarmos o id devolvido pelo envio.
-- ============================================================================
create or replace function dental_leads.ingest_outbound_event(
  p_whatsapp_id         text,
  p_phone               text,
  p_is_lid              boolean,
  p_name                text,
  p_provider_message_id text,
  p_message_type        text,
  p_text                text,
  p_meta                jsonb,
  p_occurred_at         timestamptz,
  p_grace_seconds       int default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead      dental_leads.leads%rowtype;
  v_pending   uuid;
  v_existing  uuid;
begin
  select * into v_lead from dental_leads.leads where whatsapp_id = p_whatsapp_id;

  -- Conversa iniciada pela clínica: o lead ainda não existe aqui. Quem falou
  -- primeiro foi um humano, então a automação já nasce em takeover.
  if v_lead.id is null then
    insert into dental_leads.leads (
      whatsapp_id, phone, is_lid, name, stage,
      automation_status, human_reason, last_message_at
    )
    values (
      p_whatsapp_id, nullif(p_phone, ''), coalesce(p_is_lid, false), nullif(p_name, ''),
      'CONVERSATION', 'HUMAN_TAKEOVER', 'conversa iniciada manualmente pela equipe',
      coalesce(p_occurred_at, now())
    )
    returning * into v_lead;
  end if;

  -- Caso 1: mensagem que nós mesmos enviamos e já registramos.
  select id into v_existing
    from dental_leads.messages
   where provider_message_id = p_provider_message_id;

  if v_existing is not null then
    return jsonb_build_object('takeover', false, 'reason', 'known_message', 'lead_id', v_lead.id);
  end if;

  -- Caso 2: envio nosso ainda sem provider_message_id, mesmo texto, dentro da
  -- janela de graça.
  select id into v_pending
    from dental_leads.messages
   where lead_id = v_lead.id
     and direction = 'OUT'
     and sender_type = 'AI'
     and provider_message_id is null
     and created_at > now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 120), 0))
     and lower(btrim(coalesce(text, ''))) = lower(btrim(coalesce(p_text, '')))
   order by created_at desc
   limit 1;

  if v_pending is not null then
    update dental_leads.messages
       set provider_message_id = p_provider_message_id
     where id = v_pending;
    return jsonb_build_object('takeover', false, 'reason', 'linked_pending', 'lead_id', v_lead.id);
  end if;

  -- Caso 3: humano respondeu pelo WhatsApp. A IA para até alguém reativar
  -- manualmente pelo painel.
  insert into dental_leads.messages (
    lead_id, provider_message_id, direction, sender_type,
    message_type, text, processed, meta, created_at
  )
  values (
    v_lead.id, p_provider_message_id, 'OUT', 'HUMAN',
    coalesce(p_message_type, 'TEXT'), p_text, true, p_meta,
    coalesce(p_occurred_at, now())
  )
  on conflict (provider_message_id) do nothing;

  update dental_leads.leads
     set automation_status = 'HUMAN_TAKEOVER',
         human_reason      = 'humano respondeu pelo WhatsApp',
         last_message_at   = greatest(coalesce(last_message_at, to_timestamp(0)),
                                      coalesce(p_occurred_at, now()))
   where id = v_lead.id;

  -- Jobs pendentes desse lead perdem o sentido: quem está conduzindo a
  -- conversa agora é uma pessoa.
  update dental_leads.jobs
     set status = 'DONE', last_error = 'cancelado por human takeover'
   where lead_id = v_lead.id and status = 'PENDING';

  return jsonb_build_object('takeover', true, 'reason', 'human_reply', 'lead_id', v_lead.id);
end $$;

-- ============================================================================
-- RPC 3 — claim_jobs
--
-- FOR UPDATE SKIP LOCKED: dois workers rodando ao mesmo tempo (webhook +
-- cron de segurança) nunca pegam o mesmo job.
-- ============================================================================
create or replace function dental_leads.claim_jobs(p_limit int default 5)
returns table (
  job_id     bigint,
  lead_id    uuid,
  message_id uuid,
  attempts   int
)
language sql
security definer
set search_path = public
as $$
  update dental_leads.jobs j
     set status    = 'RUNNING',
         attempts  = j.attempts + 1,
         locked_at = now()
   where j.id in (
     select id from dental_leads.jobs
      where status = 'PENDING'
        and next_attempt_at <= now()
      order by next_attempt_at
      limit greatest(coalesce(p_limit, 5), 1)
      for update skip locked
   )
  returning j.id, j.lead_id, j.message_id, j.attempts;
$$;

-- ============================================================================
-- RPC 4 — finish_job (sucesso, ou retry com backoff exponencial)
--
-- Esgotadas as tentativas o lead vai para HUMAN_REQUIRED: nenhum lead pode
-- morrer em silêncio dentro da fila.
-- ============================================================================
create or replace function dental_leads.finish_job(
  p_job_id       bigint,
  p_ok           boolean,
  p_error        text default null,
  p_max_attempts int default 4,
  p_backoff_base int default 120
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job dental_leads.jobs%rowtype;
begin
  select * into v_job from dental_leads.jobs where id = p_job_id;
  if v_job.id is null then
    return;
  end if;

  if p_ok then
    update dental_leads.jobs set status = 'DONE', last_error = null where id = p_job_id;
    update dental_leads.messages set processed = true where id = v_job.message_id;
    return;
  end if;

  if v_job.attempts >= greatest(coalesce(p_max_attempts, 4), 1) then
    update dental_leads.jobs set status = 'FAILED', last_error = p_error where id = p_job_id;
    update dental_leads.leads
       set needs_human  = true,
           automation_status = case
                                 when automation_status = 'ACTIVE' then 'HUMAN_REQUIRED'::automation_status
                                 else automation_status
                               end,
           human_reason = 'falha técnica no processamento automático'
     where id = v_job.lead_id;
  else
    update dental_leads.jobs
       set status          = 'PENDING',
           last_error      = p_error,
           locked_at       = null,
           next_attempt_at = now() + make_interval(
             secs => coalesce(p_backoff_base, 120) * power(2, v_job.attempts)::int
           )
     where id = p_job_id;
  end if;
end $$;

-- ============================================================================
-- RPC 5 — get_send_stats: tudo que canSendMessage() precisa, em 1 ida ao banco
-- ============================================================================
create or replace function dental_leads.get_send_stats(p_lead_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'last_out_at',   (select max(created_at) from dental_leads.messages
                       where lead_id = p_lead_id and direction = 'OUT'),
    'last_out_text', (select text from dental_leads.messages
                       where lead_id = p_lead_id and direction = 'OUT'
                       order by created_at desc limit 1),
    'hour_count',    (select count(*) from dental_leads.messages
                       where lead_id = p_lead_id and direction = 'OUT'
                         and sender_type = 'AI' and created_at > now() - interval '1 hour'),
    'day_count',     (select count(*) from dental_leads.messages
                       where lead_id = p_lead_id and direction = 'OUT'
                         and sender_type = 'AI' and created_at > now() - interval '24 hours')
  );
$$;

-- ============================================================================
-- Segurança / RLS
--
-- O painel usa apenas a anon key + login. Nunca service role no navegador.
-- Service role (Edge Functions) ignora RLS por definição.
-- ============================================================================
alter table dental_leads.leads                enable row level security;
alter table dental_leads.messages             enable row level security;
alter table dental_leads.automation_decisions enable row level security;
alter table dental_leads.jobs                 enable row level security;

-- O Supabase concede privilégios amplos por padrão em tabelas novas.
-- Aqui isso é revogado e reconcedido de forma mínima.
revoke all on dental_leads.leads, dental_leads.messages, dental_leads.automation_decisions, dental_leads.jobs
  from anon, authenticated;

grant select on dental_leads.leads, dental_leads.messages, dental_leads.automation_decisions to authenticated;

-- O painel só pode mexer no que a tela oferece: mover etapa, ligar/desligar a
-- IA, resolver a pendência humana e corrigir o interesse. Nada além disso —
-- restrição por coluna, não por confiança no frontend.
grant update (stage, automation_status, needs_human, human_reason, treatment_interest)
  on dental_leads.leads to authenticated;

drop policy if exists leads_read on dental_leads.leads;
create policy leads_read on dental_leads.leads
  for select to authenticated using (true);

drop policy if exists leads_update on dental_leads.leads;
create policy leads_update on dental_leads.leads
  for update to authenticated using (true) with check (true);

drop policy if exists messages_read on dental_leads.messages;
create policy messages_read on dental_leads.messages
  for select to authenticated using (true);

drop policy if exists decisions_read on dental_leads.automation_decisions;
create policy decisions_read on dental_leads.automation_decisions
  for select to authenticated using (true);

-- jobs não tem policy nenhuma: invisível para o painel, de propósito.

-- As RPCs de escrita são exclusivas do backend (service role).
revoke all on function dental_leads.ingest_inbound_message(text,text,boolean,text,text,text,text,jsonb,timestamptz,boolean,text) from public, anon, authenticated;
revoke all on function dental_leads.ingest_outbound_event(text,text,boolean,text,text,text,text,jsonb,timestamptz,int) from public, anon, authenticated;
revoke all on function dental_leads.claim_jobs(int) from public, anon, authenticated;
revoke all on function dental_leads.finish_job(bigint,boolean,text,int,int) from public, anon, authenticated;
revoke all on function dental_leads.get_send_stats(uuid) from public, anon, authenticated;
