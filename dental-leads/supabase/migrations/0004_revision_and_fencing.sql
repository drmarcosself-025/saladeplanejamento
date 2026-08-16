-- ============================================================================
-- Correções da auditoria de F1 — dois gaps reais encontrados:
--
-- 1. Detecção de stale dependia só de um NOT EXISTS sobre mensagens não
--    consumidas. Funciona, mas não é o mecanismo pedido: um contador
--    monotônico (conversation_revision / input_revision) é mais barato de
--    checar (O(1) vs varredura) e serve de base para outras decisões futuras
--    ("algo mudou desde X"). Mantido o NOT EXISTS como defesa em profundidade.
--
-- 2. A posse do lease era validada por assert_turn_valid() e a ESCRITA da
--    bolha acontecia numa chamada SEPARADA logo depois — havia uma janela
--    (TOCTOU) entre confirmar posse e gravar. reserve_outbound_bubble() fecha
--    essa janela: checagem de posse + revisão + a própria INSERT acontecem
--    numa única função, com a linha do job travada (FOR UPDATE) durante toda
--    a operação. É isto que impede um worker que perdeu o lease de continuar
--    executando a ação crítica (gravar/enviar), não apenas de "achar que
--    pode".
--
-- Também resolve o pedido de tornar auditável qual turno consumiu cada
-- mensagem: processed (boolean ambíguo) dá lugar a consumed_at +
-- consumed_by_turn_id.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- leads: contador monotônico da conversa
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists conversation_revision bigint not null default 0;

-- ---------------------------------------------------------------------------
-- messages: consumed_at/consumed_by_turn_id substituem processed
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists consumed_at         timestamptz,
  add column if not exists consumed_by_turn_id uuid;

-- Backfill coerente com o que já existia (ambiente de desenvolvimento; ainda
-- sem produção).
update public.messages
   set consumed_at = created_at
 where processed = true and consumed_at is null;

drop index if exists messages_pending_in_idx;
create index if not exists messages_pending_in_idx
  on public.messages (lead_id, received_at)
  where direction = 'IN' and consumed_at is null;

create index if not exists messages_consumed_by_turn_idx
  on public.messages (consumed_by_turn_id)
  where consumed_by_turn_id is not null;

alter table public.messages drop column if exists processed;

-- ---------------------------------------------------------------------------
-- automation_decisions: trilha de auditoria da revisão capturada no turno
-- ---------------------------------------------------------------------------
alter table public.automation_decisions
  add column if not exists input_revision bigint;

-- ============================================================================
-- ingest_inbound_message — incrementa a revisão em toda mensagem IN genuína
--
-- A reentrega da Evolution (provider_message_id repetido) NÃO incrementa: o
-- ON CONFLICT DO NOTHING já barra antes de chegarmos aqui, então só mensagem
-- de verdade nova mexe no contador.
-- ============================================================================
create or replace function public.ingest_inbound_message(
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
  v_lead       public.leads%rowtype;
  v_message_id uuid;
  v_received   timestamptz := clock_timestamp();
  v_enqueue    boolean;
  v_job_id     bigint;
  v_revision   bigint;
begin
  insert into public.leads (whatsapp_id, phone, is_lid, name, last_message_at, last_inbound_at)
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

  insert into public.messages (
    lead_id, provider_message_id, direction, sender_type, message_type, text,
    consumed_at, meta, provider_timestamp, received_at, content_hash,
    reply_to_provider_id, links, created_at
  )
  values (
    v_lead.id, p_provider_message_id, 'IN', 'LEAD', coalesce(p_message_type, 'TEXT'), p_text,
    -- Mensagem que nunca vai entrar numa fila (automação não ACTIVE) já
    -- nasce "consumida": não há turno que vá processá-la.
    case when not v_enqueue then v_received else null end,
    p_meta, p_provider_timestamp, v_received, p_content_hash,
    p_reply_to_provider_id, p_links, v_received
  )
  on conflict (provider_message_id) do nothing
  returning id into v_message_id;

  -- Reentrega da Evolution: não responde de novo, não duplica, não reinicia
  -- a janela de debounce, não mexe na revisão da conversa.
  if v_message_id is null then
    return jsonb_build_object(
      'duplicate', true, 'lead_id', v_lead.id, 'enqueued', false,
      'revision', v_lead.conversation_revision
    );
  end if;

  -- Contador monotônico: toda mensagem IN genuína muda a conversa. É a base
  -- barata (O(1)) de "algo mudou desde que o turno começou".
  update public.leads
     set conversation_revision = conversation_revision + 1
   where id = v_lead.id
   returning conversation_revision into v_revision;

  if coalesce(p_needs_human, false) then
    update public.leads
       set needs_human  = true,
           human_reason = coalesce(p_human_reason, human_reason)
     where id = v_lead.id;
  end if;

  if v_enqueue then
    insert into public.jobs (lead_id, status, debounce_started_at, run_after, next_attempt_at)
    values (
      v_lead.id, 'PENDING', v_received,
      v_received + make_interval(secs => greatest(coalesce(p_debounce_seconds, 5), 0)),
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
    'job_id', v_job_id,
    'revision', v_revision
  );
end $$;

-- ============================================================================
-- fetch_batch — agora também devolve a revisão da conversa NA MESMA consulta
-- que lê as mensagens.
--
-- Isso importa: se a revisão fosse lida numa instrução separada (ex.: dentro
-- do claim, antes do fetch), uma mensagem que chegasse entre as duas
-- instruções apareceria no batch mas com uma revisão "velha" — o turno se
-- descartaria sozinho por engano, mesmo com o batch completo e correto. Como
-- é uma única instrução SQL, revisão e mensagens compartilham o mesmo
-- snapshot MVCC: sempre consistentes entre si.
-- ============================================================================
drop function if exists public.fetch_batch(uuid);

create or replace function public.fetch_batch(p_lead_id uuid)
returns table (
  id                    uuid,
  text                  text,
  message_type          text,
  provider_timestamp    timestamptz,
  received_at           timestamptz,
  links                 jsonb,
  conversation_revision bigint
)
language sql
security definer
set search_path = public
as $$
  select m.id, m.text, m.message_type, m.provider_timestamp, m.received_at, m.links,
         (select l.conversation_revision from public.leads l where l.id = p_lead_id)
    from public.messages m
   where m.lead_id = p_lead_id
     and m.direction = 'IN'
     and m.consumed_at is null
   order by m.received_at, m.id;
$$;

-- ============================================================================
-- assert_turn_valid — checkpoint de LEITURA (não escreve nada). Usado
-- pós-IA e como filtro barato antes de gastar uma consulta de rate limit.
-- A checagem que efetivamente PROTEGE o envio é reserve_outbound_bubble.
--
-- Ganha p_input_revision: comparação O(1) com a revisão atual do lead.
-- Mantém o NOT EXISTS como defesa em profundidade (cobre qualquer inserção
-- futura de mensagem IN que por bug não passe por ingest_inbound_message).
-- ============================================================================
drop function if exists public.assert_turn_valid(bigint,text,uuid,uuid[],text);

create or replace function public.assert_turn_valid(
  p_job_id          bigint,
  p_worker_id       text,
  p_lead_id         uuid,
  p_batch_ids       uuid[],
  p_input_revision  bigint,
  p_purpose         text default 'AI_REPLY'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job  public.jobs%rowtype;
  v_lead public.leads%rowtype;
begin
  select * into v_job from public.jobs where id = p_job_id;

  if v_job.id is null
     or v_job.status <> 'RUNNING'
     or v_job.locked_by is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    return jsonb_build_object('valid', false, 'reason', 'lease_perdido');
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    return jsonb_build_object('valid', false, 'reason', 'lead_inexistente');
  end if;

  if v_lead.automation_status = 'HUMAN_TAKEOVER' then
    return jsonb_build_object('valid', false, 'reason', 'human_takeover');
  end if;

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

  -- Checagem primária: o contador mudou desde que o batch foi capturado?
  if v_lead.conversation_revision <> p_input_revision then
    return jsonb_build_object('valid', false, 'reason', 'stale_revision_mismatch');
  end if;

  -- Defesa em profundidade: mesmo com a revisão batendo, confirma que não
  -- existe mensagem IN não consumida fora do batch.
  if exists (
    select 1 from public.messages
     where lead_id = p_lead_id
       and direction = 'IN'
       and consumed_at is null
       and not (id = any (coalesce(p_batch_ids, array[]::uuid[])))
  ) then
    return jsonb_build_object('valid', false, 'reason', 'stale_nova_mensagem');
  end if;

  return jsonb_build_object('valid', true, 'reason', 'ok');
end $$;

-- ============================================================================
-- reserve_outbound_bubble — o portão atômico de verdade.
--
-- Faz numa ÚNICA transação o que antes era checar (assert_turn_valid) e só
-- depois gravar (INSERT em messages), em duas chamadas separadas. Entre as
-- duas havia uma janela real, ainda que estreita, em que um worker que
-- acabara de perder o lease podia gravar mesmo assim (clássico TOCTOU).
--
-- Fechamento: a linha do job é travada com FOR UPDATE durante toda a função.
-- Qualquer reclaim_expired_jobs ou renew_lease concorrente sobre o MESMO job
-- serializa contra esta transação — ou já rodou antes (e nossa checagem de
-- posse abaixo vê o estado novo e recusa corretamente), ou espera esta
-- transação terminar (e só então enxerga o estado que ficou). Não existe
-- meio-termo onde os dois "pensam" que têm posse ao mesmo tempo.
--
-- Reprova pelos mesmos motivos de assert_turn_valid, mais duplicidade de
-- conteúdo (bolha idêntica já enviada recentemente = worker zumbi).
-- ============================================================================
create or replace function public.reserve_outbound_bubble(
  p_job_id         bigint,
  p_worker_id      text,
  p_lead_id        uuid,
  p_input_revision bigint,
  p_batch_ids      uuid[],
  p_purpose        text,
  p_turn_id        uuid,
  p_sequence       int,
  p_text           text,
  p_content_hash   text,
  p_dedupe_seconds int default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job  public.jobs%rowtype;
  v_lead public.leads%rowtype;
  v_dup  uuid;
  v_msg  uuid;
begin
  -- Trava a linha do job pelo resto da função: é isto que fecha a janela.
  select * into v_job from public.jobs where id = p_job_id for update;

  if v_job.id is null
     or v_job.status <> 'RUNNING'
     or v_job.locked_by is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    return jsonb_build_object('reserved', false, 'reason', 'lease_perdido');
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null then
    return jsonb_build_object('reserved', false, 'reason', 'lead_inexistente');
  end if;

  if v_lead.automation_status = 'HUMAN_TAKEOVER' then
    return jsonb_build_object('reserved', false, 'reason', 'human_takeover');
  end if;

  if p_purpose = 'HANDOFF' then
    if v_lead.automation_status not in ('ACTIVE','HUMAN_REQUIRED') then
      return jsonb_build_object('reserved', false, 'reason', 'automacao_inativa:' || v_lead.automation_status);
    end if;
  else
    if v_lead.automation_status <> 'ACTIVE' then
      return jsonb_build_object('reserved', false, 'reason', 'automacao_inativa:' || v_lead.automation_status);
    end if;
    if v_lead.needs_human then
      return jsonb_build_object('reserved', false, 'reason', 'lead_aguarda_humano');
    end if;
  end if;

  if v_lead.conversation_revision <> p_input_revision then
    return jsonb_build_object('reserved', false, 'reason', 'stale_revision_mismatch');
  end if;

  -- Defesa em profundidade (mesmo espírito do assert_turn_valid): mesmo com
  -- a revisão batendo, confirma que não existe mensagem IN não consumida
  -- FORA do conjunto que este turno está respondendo.
  if exists (
    select 1 from public.messages
     where lead_id = p_lead_id
       and direction = 'IN'
       and consumed_at is null
       and not (id = any (coalesce(p_batch_ids, array[]::uuid[])))
  ) then
    return jsonb_build_object('reserved', false, 'reason', 'stale_nova_mensagem');
  end if;

  select id into v_dup
    from public.messages
   where lead_id = p_lead_id
     and direction = 'OUT'
     and content_hash = p_content_hash
     and created_at > now() - make_interval(secs => greatest(coalesce(p_dedupe_seconds, 120), 0))
   limit 1;

  if v_dup is not null then
    return jsonb_build_object('reserved', false, 'reason', 'duplicado', 'message_id', v_dup);
  end if;

  insert into public.messages (
    lead_id, direction, sender_type, message_type, text,
    content_hash, send_status, turn_id, bubble_sequence, meta,
    received_at, created_at
  )
  values (
    p_lead_id, 'OUT', 'AI', 'TEXT', p_text,
    p_content_hash, 'PENDING', p_turn_id, p_sequence,
    jsonb_build_object('purpose', p_purpose),
    clock_timestamp(), clock_timestamp()
  )
  returning id into v_msg;

  return jsonb_build_object('reserved', true, 'message_id', v_msg);
end $$;

-- ============================================================================
-- close_turn — consumed_at/consumed_by_turn_id no lugar de processed
-- ============================================================================
create or replace function public.close_turn(
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
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if v_job.id is null then
    return jsonb_build_object('closed', false, 'reason', 'job_inexistente');
  end if;

  if p_mark_processed and p_batch_ids is not null then
    update public.messages
       set consumed_at = clock_timestamp(),
           consumed_by_turn_id = v_job.turn_id
     where id = any (p_batch_ids);
  end if;

  if p_outcome = 'FAILED' then
    if v_job.attempts >= greatest(coalesce(p_max_attempts, 4), 1) then
      update public.jobs
         set status = 'FAILED', outcome = p_outcome, last_error = p_error,
             locked_by = null, lease_expires_at = null
       where id = p_job_id;

      update public.leads
         set needs_human = true,
             automation_status = case
                                   when automation_status = 'ACTIVE' then 'HUMAN_REQUIRED'::automation_status
                                   else automation_status
                                 end,
             human_reason = 'falha técnica no processamento automático'
       where id = v_job.lead_id;

      return jsonb_build_object('closed', true, 'retry', false);
    end if;

    update public.jobs
       set status = 'PENDING',
           last_error = p_error,
           locked_by = null,
           lease_expires_at = null,
           next_attempt_at = now() + make_interval(secs => coalesce(p_backoff_base, 120) * power(2, v_job.attempts)::int),
           run_after = now() + make_interval(secs => coalesce(p_backoff_base, 120) * power(2, v_job.attempts)::int)
     where id = p_job_id;

    return jsonb_build_object('closed', true, 'retry', true);
  end if;

  update public.jobs
     set status = 'DONE', outcome = p_outcome, last_error = p_error,
         locked_by = null, lease_expires_at = null
   where id = p_job_id;

  return jsonb_build_object('closed', true, 'retry', false);
end $$;

-- ============================================================================
-- ingest_outbound_event — parava de referenciar processed (coluna removida).
-- Mensagem HUMAN inserida por takeover não é "consumida" por turno nenhum:
-- consumed_at/consumed_by_turn_id ficam null (são conceito de mensagem IN).
-- ============================================================================
create or replace function public.ingest_outbound_event(
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
  v_lead     public.leads%rowtype;
  v_pending  uuid;
  v_existing uuid;
begin
  select * into v_lead from public.leads where whatsapp_id = p_whatsapp_id;

  if v_lead.id is null then
    insert into public.leads (
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
    from public.messages where provider_message_id = p_provider_message_id;

  if v_existing is not null then
    return jsonb_build_object('takeover', false, 'reason', 'known_message', 'lead_id', v_lead.id);
  end if;

  select id into v_pending
    from public.messages
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
    update public.messages
       set provider_message_id = p_provider_message_id,
           send_status = 'SENT'
     where id = v_pending;
    return jsonb_build_object('takeover', false, 'reason', 'linked_pending', 'lead_id', v_lead.id);
  end if;

  insert into public.messages (
    lead_id, provider_message_id, direction, sender_type, message_type, text,
    meta, provider_timestamp, received_at, content_hash, send_status, created_at
  )
  values (
    v_lead.id, p_provider_message_id, 'OUT', 'HUMAN', coalesce(p_message_type, 'TEXT'), p_text,
    p_meta, p_occurred_at, now(), p_content_hash, 'SENT', coalesce(p_occurred_at, now())
  )
  on conflict (provider_message_id) do nothing;

  update public.leads
     set automation_status = 'HUMAN_TAKEOVER',
         human_reason      = 'humano respondeu pelo WhatsApp',
         last_message_at   = greatest(coalesce(last_message_at, to_timestamp(0)), coalesce(p_occurred_at, now())),
         last_outbound_at  = greatest(coalesce(last_outbound_at, to_timestamp(0)), coalesce(p_occurred_at, now()))
   where id = v_lead.id;

  update public.jobs
     set status = 'DONE', outcome = 'HUMAN_TAKEOVER', last_error = 'cancelado por human takeover'
   where lead_id = v_lead.id and status = 'PENDING';

  return jsonb_build_object('takeover', true, 'reason', 'human_reply', 'lead_id', v_lead.id);
end $$;

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
revoke all on function public.ingest_inbound_message(text,text,boolean,text,text,text,text,jsonb,timestamptz,text,text,jsonb,boolean,text,int,int) from public, anon, authenticated;
revoke all on function public.fetch_batch(uuid) from public, anon, authenticated;
revoke all on function public.assert_turn_valid(bigint,text,uuid,uuid[],bigint,text) from public, anon, authenticated;
revoke all on function public.reserve_outbound_bubble(bigint,text,uuid,bigint,uuid[],text,uuid,int,text,text,int) from public, anon, authenticated;
revoke all on function public.close_turn(bigint,text,turn_outcome,uuid[],boolean,text,int,int) from public, anon, authenticated;
revoke all on function public.ingest_outbound_event(text,text,boolean,text,text,text,text,jsonb,timestamptz,int,text) from public, anon, authenticated;
