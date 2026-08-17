set search_path = dental_leads, public, extensions;

-- ============================================================================
-- F2 — envio sequencial seguro em bolhas.
--
-- Esta migration NÃO adiciona lógica de negócio nova (IA, playbook, funil).
-- É só o que sustenta reply_messages[] com segurança, incorporando a segunda
-- rodada de revisão:
--   * turn_id como token de fencing de verdade (não só worker_id);
--   * estado SENDING entre PENDING e SENT/FAILED/UNKNOWN;
--   * reconciliação de bolha travada em SENDING (worker morreu entre o POST
--     aceito pela Evolution e a gravação do resultado);
--   * CANCELLED só a partir de PENDING;
--   * UNIQUE (turn_id, bubble_sequence);
--   * SUPERSEDED / YIELDED / SEND_FAILED como desfechos honestos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- send_status ganha SENDING. turn_outcome ganha SUPERSEDED, YIELDED e
-- SEND_FAILED (falha permanente, distinta de SEND_UNKNOWN que já existia).
-- Nenhum dos três novos valores de turn_outcome é erro de automação — não
-- devem disparar alerta de falha (push F4).
-- ---------------------------------------------------------------------------
alter type send_status add value if not exists 'SENDING';
alter type turn_outcome add value if not exists 'SUPERSEDED';
alter type turn_outcome add value if not exists 'YIELDED';
alter type turn_outcome add value if not exists 'SEND_FAILED';

-- Postgres não deixa usar um valor de enum recém-criado na mesma transação
-- em que foi adicionado (SQLSTATE 55P04). Fecha a transação aqui para que
-- 'SENDING' e os novos turn_outcome já estejam commitados antes de aparecer
-- em WHERE/CASE mais abaixo neste mesmo arquivo.
commit;
begin;
set search_path = dental_leads, public, extensions;

-- ---------------------------------------------------------------------------
-- messages: quem reservou cada bolha, e com qual token de fencing.
--
-- turn_id (já existente desde a F1) É o token de fencing: claim_lead_jobs
-- gera um turn_id novo a cada vez que um job é claimado. Uma bolha só é
-- legítima se o turn_id gravado nela ainda for o turn_id ATUAL do job — se o
-- job foi reclaimado (lease expirou, outro worker assumiu), o job ganha um
-- turn_id novo e qualquer bolha com o turn_id antigo passa a ser
-- automaticamente reconhecida como órfã. Não é preciso um contador numérico
-- separado: turn_id já muda a cada concessão de lease e já é gravado em toda
-- bolha — faltava só COMPARAR contra ele nos pontos certos (feito abaixo).
-- ---------------------------------------------------------------------------
alter table dental_leads.messages
  add column if not exists reserved_job_id    bigint references dental_leads.jobs(id),
  add column if not exists reserved_worker_id text;

create index if not exists messages_reserved_job_idx
  on dental_leads.messages (reserved_job_id)
  where reserved_job_id is not null;

-- Nunca duas bolhas com o mesmo número de sequência no mesmo turno. Defesa
-- em profundidade contra um bug de retry reservando a mesma posição 2x.
create unique index if not exists messages_turn_sequence_uidx
  on dental_leads.messages (turn_id, bubble_sequence)
  where direction = 'OUT' and sender_type = 'AI';

-- Localiza rápido toda bolha travada em SENDING (rotina de reconciliação).
create index if not exists messages_sending_idx
  on dental_leads.messages (reserved_job_id, turn_id)
  where send_status = 'SENDING';

-- ---------------------------------------------------------------------------
-- automation_decisions: bubbles_planned. messages continua sendo a fonte de
-- verdade por bolha — este campo é só conveniência de consulta.
-- ---------------------------------------------------------------------------
alter table dental_leads.automation_decisions
  add column if not exists bubbles_planned int not null default 0;

-- ============================================================================
-- reclaim_expired_jobs — SUPERSEDED em vez de FAILED quando já existe um
-- turno mais novo para o mesmo lead (não é erro).
-- ============================================================================
create or replace function dental_leads.reclaim_expired_jobs()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requeued int;
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
     and not exists (
       select 1 from dental_leads.jobs p
        where p.lead_id = jobs.lead_id and p.status = 'PENDING'
     );
  get diagnostics v_requeued = row_count;

  update dental_leads.jobs
     set status = 'DONE',
         outcome = 'SUPERSEDED',
         locked_by = null,
         lease_expires_at = null,
         last_error = 'lease expirado; superado por turno mais novo do mesmo lead'
   where status = 'RUNNING'
     and lease_expires_at is not null
     and lease_expires_at <= now();

  return v_requeued;
exception when unique_violation then
  return 0;
end $$;

-- ============================================================================
-- reconcile_stuck_sending_bubbles — cobre o crash entre "Evolution aceitou o
-- POST" e "gravamos SENT".
--
-- Uma bolha em SENDING cujo job reservante não está mais RUNNING com o MESMO
-- turn_id e lease viva está órfã: o worker que a estava enviando morreu (ou
-- teve o lease reclamado) no meio do envio. Não sabemos se a Evolution
-- entregou — vira UNKNOWN, nunca PENDING (nunca reenviada automaticamente), e
-- o lead vira needs_human.
--
-- Chamada em toda invocação do worker, no mesmo momento que
-- reclaim_expired_jobs. A ordem entre as duas não importa: a condição aqui é
-- lida direto do estado atual do job, não depende de reclaim já ter rodado.
-- ============================================================================
create or replace function dental_leads.reconcile_stuck_sending_bubbles()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leads uuid[];
  v_count int;
begin
  with stuck as (
    update dental_leads.messages m
       set send_status = 'UNKNOWN'
     where m.send_status = 'SENDING'
       and not exists (
         select 1 from dental_leads.jobs j
          where j.id = m.reserved_job_id
            and j.turn_id = m.turn_id
            and j.status = 'RUNNING'
            and j.lease_expires_at > now()
       )
    returning m.lead_id
  )
  select array_agg(distinct lead_id), count(*) into v_leads, v_count from stuck;

  if v_leads is not null then
    update dental_leads.leads
       set needs_human = true,
           automation_status = case
                                 when automation_status = 'ACTIVE' then 'HUMAN_REQUIRED'::automation_status
                                 else automation_status
                               end,
           human_reason = 'envio ficou sem confirmação (worker interrompido) — conferir no WhatsApp'
     where id = any (v_leads);
  end if;

  return coalesce(v_count, 0);
end $$;

-- ============================================================================
-- yield_turn — devolução por orçamento de parede. Só quem tem o lease pode
-- ceder. Não gasta tentativa, não mexe em needs_human.
--
-- A decisão de QUANDO chamar isto (só antes da 1ª bolha, nunca depois de
-- alguma já ter sido SENT) é responsabilidade do chamador — ver
-- lead-worker/index.ts. Esta função só executa a devolução.
-- ============================================================================
create or replace function dental_leads.yield_turn(
  p_job_id    bigint,
  p_worker_id text
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
     set status = 'PENDING',
         locked_by = null,
         lease_expires_at = null,
         run_after = now(),
         outcome = 'YIELDED',
         last_error = 'devolvido por orçamento de parede (WORKER_WALL_BUDGET_MS)'
   where id = p_job_id
     and locked_by = p_worker_id
     and status = 'RUNNING';
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

-- ============================================================================
-- assert_turn_valid — checkpoint de LEITURA, agora com fencing por turn_id.
--
-- Usado uma vez por turno, logo depois da IA responder, ANTES de começar a
-- reservar qualquer bolha — evita o custo de reserva+cancelamento quando o
-- turno já morreu de forma óbvia. A validação de verdade, atômica e
-- imediatamente antes do POST, é advance_bubble_to_sending.
-- ============================================================================
drop function if exists dental_leads.assert_turn_valid(bigint,text,uuid,uuid[],bigint,text);

create or replace function dental_leads.assert_turn_valid(
  p_job_id          bigint,
  p_worker_id       text,
  p_turn_id         uuid,
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
  v_job  dental_leads.jobs%rowtype;
  v_lead dental_leads.leads%rowtype;
begin
  select * into v_job from dental_leads.jobs where id = p_job_id;

  if v_job.id is null
     or v_job.status <> 'RUNNING'
     or v_job.locked_by is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    return jsonb_build_object('valid', false, 'reason', 'lease_perdido');
  end if;

  -- Fencing: mesmo com locked_by/status batendo, o turn_id precisa ser
  -- exatamente o da concessão de lease que originou esta chamada.
  if v_job.turn_id is distinct from p_turn_id then
    return jsonb_build_object('valid', false, 'reason', 'stale_turn_token');
  end if;

  select * into v_lead from dental_leads.leads where id = p_lead_id;
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

  if v_lead.conversation_revision <> p_input_revision then
    return jsonb_build_object('valid', false, 'reason', 'stale_revision_mismatch');
  end if;

  if exists (
    select 1 from dental_leads.messages
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
-- reserve_outbound_bubble — cria a bolha em PENDING. Ganha fencing por
-- turn_id (antes só guardava o valor; agora também EXIGE que bata com o
-- turn_id atual do job) e as colunas de auditoria reserved_job_id/
-- reserved_worker_id.
--
-- Dedupe: só um envio CONFIRMADO (send_status = SENT) conta como duplicata
-- de verdade. Checar por qualquer status (inclusive PENDING/SENDING de uma
-- tentativa anterior que nunca terminou) encalharia a bolha para sempre — a
-- próxima tentativa, gerando texto idêntico, seria recusada como "duplicada"
-- sem que a mensagem jamais tivesse chegado ao lead. UNKNOWN também fica de
-- fora de propósito: reenviar um UNKNOWN é o que o item 9 proíbe, e a
-- proteção real contra isso é needs_human=true bloqueando qualquer AI_REPLY
-- novo antes mesmo de chegar aqui.
-- ============================================================================
create or replace function dental_leads.reserve_outbound_bubble(
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
  v_job  dental_leads.jobs%rowtype;
  v_lead dental_leads.leads%rowtype;
  v_dup  uuid;
  v_msg  uuid;
begin
  select * into v_job from dental_leads.jobs where id = p_job_id for update;

  if v_job.id is null
     or v_job.status <> 'RUNNING'
     or v_job.locked_by is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    return jsonb_build_object('reserved', false, 'reason', 'lease_perdido');
  end if;

  if v_job.turn_id is distinct from p_turn_id then
    return jsonb_build_object('reserved', false, 'reason', 'stale_turn_token');
  end if;

  select * into v_lead from dental_leads.leads where id = p_lead_id for update;
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

  if exists (
    select 1 from dental_leads.messages
     where lead_id = p_lead_id
       and direction = 'IN'
       and consumed_at is null
       and not (id = any (coalesce(p_batch_ids, array[]::uuid[])))
  ) then
    return jsonb_build_object('reserved', false, 'reason', 'stale_nova_mensagem');
  end if;

  select id into v_dup
    from dental_leads.messages
   where lead_id = p_lead_id
     and direction = 'OUT'
     and content_hash = p_content_hash
     and send_status = 'SENT'
     and created_at > now() - make_interval(secs => greatest(coalesce(p_dedupe_seconds, 120), 0))
   limit 1;

  if v_dup is not null then
    return jsonb_build_object('reserved', false, 'reason', 'duplicado', 'message_id', v_dup);
  end if;

  insert into dental_leads.messages (
    lead_id, direction, sender_type, message_type, text,
    content_hash, send_status, turn_id, bubble_sequence, meta,
    reserved_job_id, reserved_worker_id,
    received_at, created_at
  )
  values (
    p_lead_id, 'OUT', 'AI', 'TEXT', p_text,
    p_content_hash, 'PENDING', p_turn_id, p_sequence,
    jsonb_build_object('purpose', p_purpose),
    p_job_id, p_worker_id,
    clock_timestamp(), clock_timestamp()
  )
  returning id into v_msg;

  return jsonb_build_object('reserved', true, 'message_id', v_msg);
end $$;

-- ============================================================================
-- advance_bubble_to_sending — o portão atômico imediatamente antes do POST.
--
-- Revalida TUDO de novo (lease, fencing por turn_id, takeover, automação,
-- revisão, conjunto de mensagens) e, se ainda válido, transiciona
-- PENDING → SENDING na mesma transação. Se inválido, cancela a bolha
-- (PENDING → CANCELLED) ali mesmo — nunca deixa a linha em PENDING "solta"
-- para alguém tentar de novo por engano.
--
-- Só transiciona bolha que realmente pertence a este job/worker/turn_id
-- (reserved_job_id/reserved_worker_id/turn_id) e que ainda está PENDING —
-- CANCELLED só é possível a partir de PENDING; depois de SENDING, a
-- tentativa já começou e não é mais cancelável por aqui.
-- ============================================================================
create or replace function dental_leads.advance_bubble_to_sending(
  p_message_id      uuid,
  p_job_id          bigint,
  p_worker_id       text,
  p_turn_id         uuid,
  p_lead_id         uuid,
  p_input_revision  bigint,
  p_batch_ids       uuid[],
  p_purpose         text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg    dental_leads.messages%rowtype;
  v_job    dental_leads.jobs%rowtype;
  v_lead   dental_leads.leads%rowtype;
  v_reason text;
begin
  select * into v_msg from dental_leads.messages where id = p_message_id;

  -- Bolha que não é nossa (id errado, já mudou de estado, pertence a outro
  -- job/worker/turn_id): não mexe em nada. Idempotente — chamar duas vezes
  -- para uma bolha já SENDING/SENT/CANCELLED só devolve advanced=false.
  if v_msg.id is null
     or v_msg.send_status <> 'PENDING'
     or v_msg.reserved_job_id is distinct from p_job_id
     or v_msg.reserved_worker_id is distinct from p_worker_id
     or v_msg.turn_id is distinct from p_turn_id then
    return jsonb_build_object('advanced', false, 'reason', 'bolha_nao_pertence_a_este_worker');
  end if;

  select * into v_job from dental_leads.jobs where id = p_job_id for update;
  select * into v_lead from dental_leads.leads where id = p_lead_id for update;

  v_reason := case
    when v_job.id is null
         or v_job.status <> 'RUNNING'
         or v_job.locked_by is distinct from p_worker_id
         or v_job.turn_id is distinct from p_turn_id
         or v_job.lease_expires_at <= now()
      then 'lease_perdido'
    when v_lead.id is null
      then 'lead_inexistente'
    when v_lead.automation_status = 'HUMAN_TAKEOVER'
      then 'human_takeover'
    when p_purpose = 'HANDOFF' and v_lead.automation_status not in ('ACTIVE','HUMAN_REQUIRED')
      then 'automacao_inativa:' || v_lead.automation_status
    when p_purpose <> 'HANDOFF' and v_lead.automation_status <> 'ACTIVE'
      then 'automacao_inativa:' || v_lead.automation_status
    when p_purpose <> 'HANDOFF' and v_lead.needs_human
      then 'lead_aguarda_humano'
    when v_lead.conversation_revision <> p_input_revision
      then 'stale_revision_mismatch'
    when exists (
           select 1 from dental_leads.messages
            where lead_id = p_lead_id
              and direction = 'IN'
              and consumed_at is null
              and not (id = any (coalesce(p_batch_ids, array[]::uuid[])))
         )
      then 'stale_nova_mensagem'
    else null
  end;

  if v_reason is not null then
    update dental_leads.messages
       set send_status = 'CANCELLED',
           meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('cancel_reason', v_reason)
     where id = p_message_id
       and send_status = 'PENDING';
    return jsonb_build_object('advanced', false, 'reason', v_reason);
  end if;

  update dental_leads.messages
     set send_status = 'SENDING'
   where id = p_message_id
     and send_status = 'PENDING';

  return jsonb_build_object('advanced', true);
end $$;

-- ============================================================================
-- cancel_reserved_bubble — cancelamento explícito de uma reserva PENDING sem
-- passar pela revalidação completa (usado quando o CHAMADOR já decidiu parar
-- por outro motivo, ex.: orçamento de parede estourou logo após reservar).
--
-- Idempotente: a segunda chamada não encontra mais send_status='PENDING' e
-- devolve false sem erro. Exige job + worker + turn_id (fencing) batendo —
-- não é só "quem tem o worker_id".
-- ============================================================================
create or replace function dental_leads.cancel_reserved_bubble(
  p_message_id uuid,
  p_job_id     bigint,
  p_worker_id  text,
  p_turn_id    uuid,
  p_reason     text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update dental_leads.messages
     set send_status = 'CANCELLED',
         meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('cancel_reason', p_reason)
   where id = p_message_id
     and reserved_job_id = p_job_id
     and reserved_worker_id = p_worker_id
     and turn_id = p_turn_id
     and send_status = 'PENDING';
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

-- ============================================================================
-- ingest_outbound_event — sem mudança de comportamento nesta migration, só
-- registrado aqui por que ele JÁ cobre a reconciliação de UNKNOWN via fromMe:
-- a busca por "bolha nossa pendente de id" (provider_message_id is null) não
-- filtra por send_status, então casa tanto com PENDING quanto com SENDING ou
-- já-reconciliada-para-UNKNOWN. Se o eco fromMe chegar depois, a bolha ganha
-- o provider_message_id de verdade e send_status volta para SENT — sem
-- código novo, e coberto por teste dedicado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
revoke all on function dental_leads.assert_turn_valid(bigint,text,uuid,uuid,uuid[],bigint,text) from public, anon, authenticated;
revoke all on function dental_leads.reserve_outbound_bubble(bigint,text,uuid,bigint,uuid[],text,uuid,int,text,text,int) from public, anon, authenticated;
revoke all on function dental_leads.advance_bubble_to_sending(uuid,bigint,text,uuid,uuid,bigint,uuid[],text) from public, anon, authenticated;
revoke all on function dental_leads.cancel_reserved_bubble(uuid,bigint,text,uuid,text) from public, anon, authenticated;
revoke all on function dental_leads.yield_turn(bigint,text) from public, anon, authenticated;
revoke all on function dental_leads.reconcile_stuck_sending_bubbles() from public, anon, authenticated;
