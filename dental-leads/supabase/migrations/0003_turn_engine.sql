set search_path = dental_leads, public, extensions;

-- ============================================================================
-- V2 / Fase 1 — motor de turno: cronologia, debounce, lock por lead e batch.
--
-- Mudança de eixo: o job deixa de ser dono de UMA mensagem e passa a ser o
-- sinal de "existe um turno para processar neste lead". O batch é montado no
-- momento do claim, com todas as mensagens IN ainda elegíveis daquele lead.
--
-- Esta migration NÃO altera IA, política, funil nem envio em bolhas — isso é
-- Fase 2 e 3. Aqui é a fundação: ordem, espera, exclusão mútua e auditoria.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tipos novos
-- ---------------------------------------------------------------------------
do $$ begin
  -- Estado de cada bolha de saída. CANCELLED é usado na Fase 2, quando um
  -- turno é interrompido no meio da sequência.
  create type send_status as enum ('PENDING','SENT','UNKNOWN','FAILED','CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Desfecho explícito de um turno. Nada de "deu certo/deu errado": cada
  -- motivo de parada precisa ser distinguível na auditoria.
  create type turn_outcome as enum (
    'COMPLETED',          -- turno concluído e resposta entregue
    'STALE_BEFORE_SEND',  -- chegou mensagem nova antes de qualquer envio
    'PARTIAL_STALE',      -- parte das bolhas saiu, o resto foi cancelado (Fase 2)
    'HUMAN_TAKEOVER',     -- humano assumiu durante o turno
    'SEND_UNKNOWN',       -- Evolution não confirmou: nunca reenviar
    'NO_REPLY',           -- decisão legítima de não responder (sticker, IGNORE)
    'FAILED'              -- erro técnico; volta para a fila com backoff
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- leads — só o que a Fase 1 usa de verdade.
-- Cadência (followup_*) fica adiada junto com o motor de follow-up.
-- ---------------------------------------------------------------------------
alter table dental_leads.leads
  add column if not exists last_inbound_at  timestamptz,
  add column if not exists last_outbound_at timestamptz;

-- ---------------------------------------------------------------------------
-- messages — cronologia e outbox.
--
-- provider_timestamp: relógio do WhatsApp (pode vir torto; serve para exibir
--                     e para desempate secundário).
-- received_at:        relógio do nosso servidor. É por ele que se ordena.
-- ---------------------------------------------------------------------------
alter table dental_leads.messages
  add column if not exists provider_timestamp   timestamptz,
  add column if not exists received_at          timestamptz not null default now(),
  add column if not exists content_hash         text,
  add column if not exists reply_to_provider_id text,
  add column if not exists links                jsonb,
  add column if not exists send_status          send_status,
  add column if not exists turn_id              uuid,
  add column if not exists bubble_sequence      int;

-- Linhas criadas antes desta migration ganham um received_at coerente.
update dental_leads.messages set received_at = created_at where received_at is null;

-- Ordenação cronológica estável: (received_at, id). Nunca ordem de SELECT.
create index if not exists messages_chrono_idx
  on dental_leads.messages (lead_id, received_at, id);

-- O batch do turno: mensagens do lead ainda não processadas.
create index if not exists messages_pending_in_idx
  on dental_leads.messages (lead_id, received_at)
  where direction = 'IN' and processed = false;

-- Todas as bolhas de uma mesma resposta compartilham turn_id.
create index if not exists messages_turn_idx
  on dental_leads.messages (turn_id)
  where turn_id is not null;

-- ---------------------------------------------------------------------------
-- automation_decisions — uma decisão por TURNO, não por mensagem.
-- ---------------------------------------------------------------------------
alter table dental_leads.automation_decisions
  add column if not exists turn_id           uuid,
  add column if not exists batch_message_ids uuid[],
  add column if not exists outcome           turn_outcome,
  add column if not exists bubbles_sent      int not null default 0;

-- message_id passa a ser "a última mensagem do batch" (referência de leitura).
-- O conjunto real fica em batch_message_ids.
comment on column dental_leads.automation_decisions.message_id is
  'Última mensagem do batch. O conjunto completo está em batch_message_ids.';

-- ---------------------------------------------------------------------------
-- jobs — de "dono de uma mensagem" para "há um turno pendente neste lead"
-- ---------------------------------------------------------------------------
alter table dental_leads.jobs drop constraint if exists jobs_message_id_key;
alter table dental_leads.jobs drop column if exists message_id;

alter table dental_leads.jobs
  -- Início da rajada. NUNCA é reescrito por mensagem nova: é ele que dá o
  -- teto de espera (o lead que digita sem parar ainda é respondido).
  add column if not exists debounce_started_at timestamptz not null default now(),
  -- Quando este turno pode ser processado. É este campo que a mensagem nova
  -- empurra para frente (janela de debounce).
  add column if not exists run_after           timestamptz not null default now(),
  add column if not exists locked_by           text,
  -- Lease com renovação (heartbeat). Worker morto devolve o job sozinho.
  add column if not exists lease_expires_at    timestamptz,
  add column if not exists turn_id             uuid,
  add column if not exists outcome             turn_outcome;

-- UM único job pendente por lead. É este índice que transforma "cada mensagem
-- cria um job" em "cada rajada é um turno".
drop index if exists jobs_ready_idx;
create unique index if not exists jobs_one_pending_per_lead
  on dental_leads.jobs (lead_id)
  where status = 'PENDING';

create index if not exists jobs_ready_idx
  on dental_leads.jobs (run_after)
  where status = 'PENDING';

-- Para reclaim de lease expirado.
create index if not exists jobs_running_lease_idx
  on dental_leads.jobs (lease_expires_at)
  where status = 'RUNNING';

-- ============================================================================
-- RPC — ingest_inbound_message (v2)
--
-- Mesma garantia da V1: uma transação; o webhook só devolve 200 depois disto.
-- O que muda: em vez de criar um job por mensagem, faz upsert do job do lead
-- empurrando a janela de debounce, com teto medido desde o início da rajada.
-- ============================================================================
drop function if exists dental_leads.ingest_inbound_message(text,text,boolean,text,text,text,text,jsonb,timestamptz,boolean,text);

create or replace function dental_leads.ingest_inbound_message(
  p_whatsapp_id         text,
  p_phone               text,
  p_is_lid              boolean,
  p_name                text,
  p_provider_message_id text,
  p_message_type        text,
  p_text                text,
  p_meta                jsonb,
  p_provider_timestamp  timestamptz,
  p_content_hash        text        default null,
  p_reply_to_provider_id text       default null,
  p_links               jsonb       default null,
  p_needs_human         boolean     default false,
  p_human_reason        text        default null,
  p_debounce_seconds    int         default 5,
  p_debounce_max_wait   int         default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead       dental_leads.leads%rowtype;
  v_message_id uuid;
  -- clock_timestamp(), não now(): now() é o horário de INÍCIO da transação e
  -- ficaria idêntico para mensagens gravadas na mesma transação, empatando a
  -- ordem cronológica e neutralizando o empurrão da janela de debounce.
  v_received   timestamptz := clock_timestamp();
  v_enqueue    boolean;
  v_job_id     bigint;
begin
  insert into dental_leads.leads (whatsapp_id, phone, is_lid, name, last_message_at, last_inbound_at)
  values (
    p_whatsapp_id, nullif(p_phone, ''), coalesce(p_is_lid, false), nullif(p_name, ''),
    v_received, v_received
  )
  on conflict (whatsapp_id) do update set
    phone           = coalesce(nullif(excluded.phone, ''), leads.phone),
    is_lid          = case when nullif(excluded.phone, '') is not null then false else leads.is_lid end,
    name            = coalesce(nullif(excluded.name, ''), leads.name),
    last_message_at = greatest(coalesce(leads.last_message_at, to_timestamp(0)), v_received),
    last_inbound_at = v_received
  returning * into v_lead;

  v_enqueue := v_lead.automation_status = 'ACTIVE';

  insert into dental_leads.messages (
    lead_id, provider_message_id, direction, sender_type, message_type, text,
    processed, meta, provider_timestamp, received_at, content_hash,
    reply_to_provider_id, links, created_at
  )
  values (
    v_lead.id, p_provider_message_id, 'IN', 'LEAD', coalesce(p_message_type, 'TEXT'), p_text,
    not v_enqueue, p_meta, p_provider_timestamp, v_received, p_content_hash,
    p_reply_to_provider_id, p_links, v_received
  )
  on conflict (provider_message_id) do nothing
  returning id into v_message_id;

  -- Reentrega da Evolution: não responde de novo, não duplica, não reinicia
  -- a janela de debounce.
  if v_message_id is null then
    return jsonb_build_object('duplicate', true, 'lead_id', v_lead.id, 'enqueued', false);
  end if;

  if coalesce(p_needs_human, false) then
    update dental_leads.leads
       set needs_human  = true,
           human_reason = coalesce(p_human_reason, human_reason)
     where id = v_lead.id;
  end if;

  if v_enqueue then
    -- Debounce: cada mensagem empurra run_after para frente, mas nunca além
    -- de debounce_started_at + teto. debounce_started_at pertence à rajada e
    -- não é reescrito aqui — é isso que impede espera infinita.
    insert into dental_leads.jobs (lead_id, status, debounce_started_at, run_after, next_attempt_at)
    values (
      v_lead.id, 'PENDING', v_received,
      v_received + make_interval(secs => greatest(coalesce(p_debounce_seconds, 5), 0)),
      -- next_attempt_at cuida só do backoff de retry; quem controla a espera
      -- da rajada é run_after. now() (início da transação) e não o clock,
      -- para o turno nunca nascer "no futuro" para o claim.
      now()
    )
    on conflict (lead_id) where status = 'PENDING'
    do update set
      run_after = least(
        v_received + make_interval(secs => greatest(coalesce(p_debounce_seconds, 5), 0)),
        jobs.debounce_started_at + make_interval(secs => greatest(coalesce(p_debounce_max_wait, 30), 1))
      )
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
-- RPC — claim_lead_jobs (substitui claim_jobs)
--
-- Lock por lead em três camadas:
--   1. índice parcial único       → nunca dois PENDING do mesmo lead;
--   2. NOT EXISTS ... RUNNING     → não claima lead que já está em processamento;
--   3. FOR UPDATE SKIP LOCKED     → dois workers nunca pegam a mesma linha.
-- Leads diferentes seguem em paralelo.
-- ============================================================================
drop function if exists dental_leads.claim_jobs(int);

create or replace function dental_leads.claim_lead_jobs(
  p_worker_id     text,
  p_limit         int default 3,
  p_lease_seconds int default 120
)
returns table (
  job_id   bigint,
  lead_id  uuid,
  attempts int,
  turn_id  uuid
)
language sql
security definer
set search_path = public
as $$
  update dental_leads.jobs j
     set status           = 'RUNNING',
         attempts         = j.attempts + 1,
         locked_by        = p_worker_id,
         locked_at        = now(),
         lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30)),
         turn_id          = gen_random_uuid()
   where j.id in (
     select q.id
       from dental_leads.jobs q
      where q.status = 'PENDING'
        and q.run_after <= now()
        and q.next_attempt_at <= now()
        and not exists (
          select 1 from dental_leads.jobs r
           where r.lead_id = q.lead_id
             and r.status = 'RUNNING'
             and r.lease_expires_at > now()
        )
      order by q.run_after
      limit greatest(coalesce(p_limit, 3), 1)
      for update skip locked
   )
  returning j.id, j.lead_id, j.attempts, j.turn_id;
$$;

-- ============================================================================
-- RPC — renew_lease (heartbeat)
--
-- Chamado nos pontos longos do turno (depois da IA, entre bolhas). Devolve
-- false quando o worker perdeu a posse — nesse caso ele deve abortar sem
-- enviar nada, porque outro worker já assumiu o lead.
-- ============================================================================
create or replace function dental_leads.renew_lease(
  p_job_id        bigint,
  p_worker_id     text,
  p_lease_seconds int default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update dental_leads.jobs
     set lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30))
   where id = p_job_id
     and locked_by = p_worker_id
     and status = 'RUNNING'
     and lease_expires_at > now();
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

-- ============================================================================
-- RPC — fetch_batch
--
-- Todas as mensagens IN ainda elegíveis do lead, em ordem cronológica
-- estável. Sem limite: o conjunto precisa ser exato para a checagem de stale
-- funcionar (o corte para o prompt é feito no worker, não aqui).
-- ============================================================================
create or replace function dental_leads.fetch_batch(p_lead_id uuid)
returns table (
  id                 uuid,
  text               text,
  message_type       text,
  provider_timestamp timestamptz,
  received_at        timestamptz,
  links              jsonb
)
language sql
security definer
set search_path = public
as $$
  select m.id, m.text, m.message_type, m.provider_timestamp, m.received_at, m.links
    from dental_leads.messages m
   where m.lead_id = p_lead_id
     and m.direction = 'IN'
     and m.processed = false
   order by m.received_at, m.id;
$$;

-- ============================================================================
-- RPC — assert_turn_valid
--
-- A pergunta do item 53, respondida em uma ida ao banco. Usada pós-IA, antes
-- da primeira bolha e antes de cada bolha seguinte.
--
-- p_purpose:
--   AI_REPLY = resposta gerada pela IA (exige automação plenamente ativa)
--   HANDOFF  = frase neutra pré-autorizada (vale também em HUMAN_REQUIRED,
--              que é exatamente a situação em que ela deve sair)
-- ============================================================================
create or replace function dental_leads.assert_turn_valid(
  p_job_id    bigint,
  p_worker_id text,
  p_lead_id   uuid,
  p_batch_ids uuid[],
  p_purpose   text default 'AI_REPLY'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job  dental_leads.jobs%rowtype;
  v_lead dental_leads.leads%rowtype;
begin
  select * into v_job from dental_leads.jobs where id = p_job_id;

  -- 1. Ainda somos donos deste turno?
  if v_job.id is null
     or v_job.status <> 'RUNNING'
     or v_job.locked_by is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    return jsonb_build_object('valid', false, 'reason', 'lease_perdido');
  end if;

  select * into v_lead from dental_leads.leads where id = p_lead_id;
  if v_lead.id is null then
    return jsonb_build_object('valid', false, 'reason', 'lead_inexistente');
  end if;

  -- 2. Humano assumiu no meio do turno?
  if v_lead.automation_status = 'HUMAN_TAKEOVER' then
    return jsonb_build_object('valid', false, 'reason', 'human_takeover');
  end if;

  -- 3. Automação continua elegível para este tipo de envio?
  if p_purpose = 'HANDOFF' then
    if v_lead.automation_status not in ('ACTIVE','HUMAN_REQUIRED') then
      return jsonb_build_object('valid', false, 'reason', 'automacao_inativa:' || v_lead.automation_status);
    end if;
  else
    if v_lead.automation_status <> 'ACTIVE' then
      return jsonb_build_object('valid', false, 'reason', 'automacao_inativa:' || v_lead.automation_status);
    end if;
    if v_lead.needs_human then
      return jsonb_build_object('valid', false, 'reason', 'lead_aguarda_humano');
    end if;
  end if;

  -- 4. Chegou mensagem nova fora do batch? (comparação por conjunto de ids:
  --    não depende de relógio nem de empate de milissegundo)
  if exists (
    select 1 from dental_leads.messages
     where lead_id = p_lead_id
       and direction = 'IN'
       and processed = false
       and not (id = any (coalesce(p_batch_ids, array[]::uuid[])))
  ) then
    return jsonb_build_object('valid', false, 'reason', 'stale_nova_mensagem');
  end if;

  return jsonb_build_object('valid', true, 'reason', 'ok');
end $$;

-- ============================================================================
-- RPC — close_turn (substitui finish_job)
--
-- Fecha o turno com desfecho explícito. Duas regras que vêm da revisão:
--   * o batch só é marcado como processado quando alguma bolha saiu — assim,
--     turno abortado antes de qualquer envio devolve as mensagens para o
--     próximo batch e o lead recebe UMA resposta coerente;
--   * FAILED volta para a fila com backoff; esgotadas as tentativas, o lead
--     vira HUMAN_REQUIRED (nenhum lead morre em silêncio na fila).
-- ============================================================================
drop function if exists dental_leads.finish_job(bigint,boolean,text,int,int);

create or replace function dental_leads.close_turn(
  p_job_id         bigint,
  p_worker_id      text,
  p_outcome        turn_outcome,
  p_batch_ids      uuid[],
  p_mark_processed boolean,
  p_error          text default null,
  p_max_attempts   int  default 4,
  p_backoff_base   int  default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job dental_leads.jobs%rowtype;
begin
  select * into v_job from dental_leads.jobs where id = p_job_id;
  if v_job.id is null then
    return jsonb_build_object('closed', false, 'reason', 'job_inexistente');
  end if;

  if p_mark_processed and p_batch_ids is not null then
    update dental_leads.messages
       set processed = true
     where id = any (p_batch_ids);
  end if;

  if p_outcome = 'FAILED' then
    if v_job.attempts >= greatest(coalesce(p_max_attempts, 4), 1) then
      update dental_leads.jobs
         set status = 'FAILED', outcome = p_outcome, last_error = p_error,
             locked_by = null, lease_expires_at = null
       where id = p_job_id;

      update dental_leads.leads
         set needs_human = true,
             automation_status = case
                                   when automation_status = 'ACTIVE' then 'HUMAN_REQUIRED'::automation_status
                                   else automation_status
                                 end,
             human_reason = 'falha técnica no processamento automático'
       where id = v_job.lead_id;

      return jsonb_build_object('closed', true, 'retry', false);
    end if;

    -- Volta para a fila. run_after acompanha o backoff para o job não ser
    -- reclaimado antes da hora.
    update dental_leads.jobs
       set status = 'PENDING',
           last_error = p_error,
           locked_by = null,
           lease_expires_at = null,
           next_attempt_at = now() + make_interval(secs => coalesce(p_backoff_base, 120) * power(2, v_job.attempts)::int),
           run_after = now() + make_interval(secs => coalesce(p_backoff_base, 120) * power(2, v_job.attempts)::int)
     where id = p_job_id;

    return jsonb_build_object('closed', true, 'retry', true);
  end if;

  update dental_leads.jobs
     set status = 'DONE', outcome = p_outcome, last_error = p_error,
         locked_by = null, lease_expires_at = null
   where id = p_job_id;

  return jsonb_build_object('closed', true, 'retry', false);
end $$;

-- ============================================================================
-- RPC — reclaim_expired_jobs
--
-- Worker morto (deploy no meio, timeout de plataforma, crash) devolve o job.
-- O turno é reprocessado do zero: como o batch só vira "processado" quando
-- alguma bolha saiu, nada se perde.
-- ============================================================================
create or replace function dental_leads.reclaim_expired_jobs()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update dental_leads.jobs
     set status = 'PENDING',
         locked_by = null,
         lease_expires_at = null,
         last_error = coalesce(last_error, 'lease expirado: worker não renovou'),
         run_after = now()
   where status = 'RUNNING'
     and lease_expires_at is not null
     and lease_expires_at <= now()
     -- Só devolve se não houver outro pendente do mesmo lead (o índice
     -- parcial único não permitiria dois).
     and not exists (
       select 1 from dental_leads.jobs p
        where p.lead_id = jobs.lead_id and p.status = 'PENDING'
     );
  get diagnostics v_count = row_count;

  -- O lead já ganhou um turno novo enquanto este agonizava: o antigo não tem
  -- para onde voltar. Fecha explicitamente em vez de deixar RUNNING órfão.
  update dental_leads.jobs
     set status = 'FAILED',
         outcome = 'FAILED',
         locked_by = null,
         lease_expires_at = null,
         last_error = 'lease expirado; lead já possui turno pendente'
   where status = 'RUNNING'
     and lease_expires_at is not null
     and lease_expires_at <= now();

  return v_count;
exception when unique_violation then
  -- Corrida com um ingest que criou um PENDING no mesmo instante: o turno
  -- novo já cobre este lead, nada a fazer.
  return 0;
end $$;

-- ============================================================================
-- RPC — get_turn_stats (substitui get_send_stats)
--
-- Correção estrutural: o rate limit conta TURNOS, não mensagens. Com resposta
-- em bolhas, contar mensagens faria a própria bolha 2 ser bloqueada pelo
-- intervalo mínimo da bolha 1.
-- ============================================================================
drop function if exists dental_leads.get_send_stats(uuid);

create or replace function dental_leads.get_turn_stats(p_lead_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'last_turn_at',  (select max(created_at) from dental_leads.automation_decisions
                       where lead_id = p_lead_id and reply_sent),
    'last_out_text', (select text from dental_leads.messages
                       where lead_id = p_lead_id and direction = 'OUT'
                         and coalesce(send_status, 'SENT') <> 'CANCELLED'
                       order by created_at desc limit 1),
    'turn_hour_count', (select count(*) from dental_leads.automation_decisions
                         where lead_id = p_lead_id and reply_sent
                           and created_at > now() - interval '1 hour'),
    'turn_day_count',  (select count(*) from dental_leads.automation_decisions
                         where lead_id = p_lead_id and reply_sent
                           and created_at > now() - interval '24 hours')
  );
$$;

-- ============================================================================
-- ingest_outbound_event — takeover agora casa também por content_hash
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
  p_grace_seconds       int default 120,
  p_content_hash        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead     dental_leads.leads%rowtype;
  v_pending  uuid;
  v_existing uuid;
begin
  select * into v_lead from dental_leads.leads where whatsapp_id = p_whatsapp_id;

  if v_lead.id is null then
    insert into dental_leads.leads (
      whatsapp_id, phone, is_lid, name, stage,
      automation_status, human_reason, last_message_at, last_outbound_at
    )
    values (
      p_whatsapp_id, nullif(p_phone, ''), coalesce(p_is_lid, false), nullif(p_name, ''),
      'CONVERSATION', 'HUMAN_TAKEOVER', 'conversa iniciada manualmente pela equipe',
      coalesce(p_occurred_at, now()), coalesce(p_occurred_at, now())
    )
    returning * into v_lead;
  end if;

  select id into v_existing
    from dental_leads.messages where provider_message_id = p_provider_message_id;

  if v_existing is not null then
    return jsonb_build_object('takeover', false, 'reason', 'known_message', 'lead_id', v_lead.id);
  end if;

  -- Bolha nossa ainda sem id (a Evolution às vezes entrega o eco antes de
  -- carimbarmos o id devolvido pelo envio). Casa por hash quando existe,
  -- por texto quando não.
  select id into v_pending
    from dental_leads.messages
   where lead_id = v_lead.id
     and direction = 'OUT'
     and sender_type = 'AI'
     and provider_message_id is null
     and created_at > now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 120), 0))
     and (
       (p_content_hash is not null and content_hash = p_content_hash)
       or lower(btrim(coalesce(text, ''))) = lower(btrim(coalesce(p_text, '')))
     )
   order by created_at desc
   limit 1;

  if v_pending is not null then
    update dental_leads.messages
       set provider_message_id = p_provider_message_id,
           send_status = 'SENT'
     where id = v_pending;
    return jsonb_build_object('takeover', false, 'reason', 'linked_pending', 'lead_id', v_lead.id);
  end if;

  insert into dental_leads.messages (
    lead_id, provider_message_id, direction, sender_type, message_type, text,
    processed, meta, provider_timestamp, received_at, content_hash, send_status, created_at
  )
  values (
    v_lead.id, p_provider_message_id, 'OUT', 'HUMAN', coalesce(p_message_type, 'TEXT'), p_text,
    true, p_meta, p_occurred_at, now(), p_content_hash, 'SENT', coalesce(p_occurred_at, now())
  )
  on conflict (provider_message_id) do nothing;

  update dental_leads.leads
     set automation_status = 'HUMAN_TAKEOVER',
         human_reason      = 'humano respondeu pelo WhatsApp',
         last_message_at   = greatest(coalesce(last_message_at, to_timestamp(0)), coalesce(p_occurred_at, now())),
         last_outbound_at  = greatest(coalesce(last_outbound_at, to_timestamp(0)), coalesce(p_occurred_at, now()))
   where id = v_lead.id;

  -- Turno pendente perde o sentido: quem conduz agora é uma pessoa. O turno
  -- em execução é interrompido pelo assert_turn_valid na próxima checagem.
  update dental_leads.jobs
     set status = 'DONE', outcome = 'HUMAN_TAKEOVER', last_error = 'cancelado por human takeover'
   where lead_id = v_lead.id and status = 'PENDING';

  return jsonb_build_object('takeover', true, 'reason', 'human_reply', 'lead_id', v_lead.id);
end $$;

-- ---------------------------------------------------------------------------
-- Permissões: as RPCs de escrita continuam exclusivas do backend.
-- ---------------------------------------------------------------------------
revoke all on function dental_leads.ingest_inbound_message(text,text,boolean,text,text,text,text,jsonb,timestamptz,text,text,jsonb,boolean,text,int,int) from public, anon, authenticated;
revoke all on function dental_leads.ingest_outbound_event(text,text,boolean,text,text,text,text,jsonb,timestamptz,int,text) from public, anon, authenticated;
revoke all on function dental_leads.claim_lead_jobs(text,int,int) from public, anon, authenticated;
revoke all on function dental_leads.renew_lease(bigint,text,int) from public, anon, authenticated;
revoke all on function dental_leads.fetch_batch(uuid) from public, anon, authenticated;
revoke all on function dental_leads.assert_turn_valid(bigint,text,uuid,uuid[],text) from public, anon, authenticated;
revoke all on function dental_leads.close_turn(bigint,text,turn_outcome,uuid[],boolean,text,int,int) from public, anon, authenticated;
revoke all on function dental_leads.reclaim_expired_jobs() from public, anon, authenticated;
revoke all on function dental_leads.get_turn_stats(uuid) from public, anon, authenticated;
