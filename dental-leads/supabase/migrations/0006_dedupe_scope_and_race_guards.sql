set search_path = dental_leads, public, extensions;

-- ============================================================================
-- Validação final pré-F3 — quatro correções reais encontradas ao auditar o
-- comportamento sob condições de corrida que os testes anteriores não
-- cobriam.
--
-- 1. Dedupe por content_hash tinha escopo largo demais: bloqueava texto
--    idêntico em turnos genuinamente diferentes (ex.: "Perfeito 😊" às 10:00
--    e de novo às 10:30, sem relação nenhuma entre si). A identidade forte
--    de uma bolha é turn_id + bubble_sequence; hash é só defesa auxiliar
--    contra retry do MESMO turno reclamado — precisa estar amarrado à
--    revisão da conversa no momento da reserva, não só a uma janela de
--    tempo solta.
-- 2. Reconciliação de fromMe podia linkar um eco a um candidato ambíguo
--    (2+ bolhas pendentes com o mesmo texto/hash na janela) escolhendo
--    silenciosamente "a mais recente" — errado quando há mais de um
--    candidato plausível.
-- 3. As escritas finais de send_status (SENT/FAILED/UNKNOWN) eram updates
--    irrestritos, sem checar se a bolha ainda pertence a este job/worker/
--    turn_id nem se ainda está em SENDING — um POST tardio podia sobrescrever
--    silenciosamente uma bolha que o reconciler já tinha movido para UNKNOWN.
-- 4. Item 4 (yield só antes da 1ª bolha SENT) já estava correto no código —
--    ganha teste dedicado e documentação explícita nesta migration/relatório.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- messages: revisão no momento da reserva (escopa o dedupe corretamente) e
-- timestamp de entrada em SENDING (base do SENDING_STALE_AFTER_MS).
-- ---------------------------------------------------------------------------
alter table dental_leads.messages
  add column if not exists reservation_revision bigint,
  add column if not exists sending_at            timestamptz;

-- ============================================================================
-- reserve_outbound_bubble — dedupe agora escopado por revisão, não só tempo.
--
-- Por quê revisão e não só (lead, hash, janela): um retry legítimo do MESMO
-- turno reclamado (worker perdeu o lease no meio, job foi reclamado, novo
-- claim gera um turn_id novo, mas o BATCH não mudou porque nenhuma mensagem
-- nova chegou) mantém a MESMA conversation_revision — é exatamente esse caso
-- que o dedupe precisa pegar. Um segundo turno genuíno, mesmo com texto
-- idêntico por coincidência, só existe porque uma mensagem nova chegou
-- (senão o batch estaria vazio e o turno nem chamaria a IA) — e mensagem
-- nova sempre incrementa a revisão. Logo: mesma revisão + mesmo hash + já
-- SENT = quase certamente o mesmo turno retomado. Revisão diferente = outro
-- momento da conversa, nunca bloqueia.
--
-- A janela de tempo continua como segunda trava (defesa em profundidade,
-- ainda protege contra o caso hipotético de revisão não ter avançado por um
-- bug em outro lugar).
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
set search_path = dental_leads, pg_temp
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
     and reservation_revision = p_input_revision
     and created_at > now() - make_interval(secs => greatest(coalesce(p_dedupe_seconds, 120), 0))
   limit 1;

  if v_dup is not null then
    return jsonb_build_object('reserved', false, 'reason', 'duplicado', 'message_id', v_dup);
  end if;

  insert into dental_leads.messages (
    lead_id, direction, sender_type, message_type, text,
    content_hash, send_status, turn_id, bubble_sequence, meta,
    reserved_job_id, reserved_worker_id, reservation_revision,
    received_at, created_at
  )
  values (
    p_lead_id, 'OUT', 'AI', 'TEXT', p_text,
    p_content_hash, 'PENDING', p_turn_id, p_sequence,
    jsonb_build_object('purpose', p_purpose),
    p_job_id, p_worker_id, p_input_revision,
    clock_timestamp(), clock_timestamp()
  )
  returning id into v_msg;

  return jsonb_build_object('reserved', true, 'message_id', v_msg);
end $$;

-- ============================================================================
-- advance_bubble_to_sending — grava sending_at na transição (base do
-- SENDING_STALE_AFTER_MS usado pela reconciliação). Regras de validação
-- inalteradas.
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
set search_path = dental_leads, pg_temp
as $$
declare
  v_msg    dental_leads.messages%rowtype;
  v_job    dental_leads.jobs%rowtype;
  v_lead   dental_leads.leads%rowtype;
  v_reason text;
begin
  select * into v_msg from dental_leads.messages where id = p_message_id;

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
     set send_status = 'SENDING',
         sending_at = clock_timestamp()
   where id = p_message_id
     and send_status = 'PENDING';

  return jsonb_build_object('advanced', true);
end $$;

-- ============================================================================
-- finalize_bubble_send — a ÚNICA porta de escrita para o resultado final de
-- uma bolha (SENT/FAILED/UNKNOWN). Substitui os updates irrestritos que
-- existiam no worker.
--
-- Só transiciona SENDING → resultado se a bolha ainda pertence a este
-- job/worker/turn_id E ainda está em SENDING. Se qualquer uma dessas
-- condições já não bate — porque o reconciler já moveu a bolha para UNKNOWN
-- enquanto o POST original ainda estava em voo — a escrita NÃO sobrescreve
-- o estado. Em vez disso, se o resultado tardio for SENT (a Evolution
-- confirmou depois que já declaramos UNKNOWN), o dado é preservado em
-- meta.late_confirmation para auditoria, sem jamais reverter needs_human
-- silenciosamente: quem já foi chamado a olhar continua sendo chamado.
-- ============================================================================
create or replace function dental_leads.finalize_bubble_send(
  p_message_id         uuid,
  p_job_id             bigint,
  p_worker_id          text,
  p_turn_id            uuid,
  p_result             send_status,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = dental_leads, pg_temp
as $$
declare
  v_msg dental_leads.messages%rowtype;
begin
  select * into v_msg from dental_leads.messages where id = p_message_id for update;

  if v_msg.id is null then
    return jsonb_build_object('finalized', false, 'late', false, 'reason', 'bolha_inexistente');
  end if;

  if v_msg.send_status = 'SENDING'
     and v_msg.reserved_job_id = p_job_id
     and v_msg.reserved_worker_id = p_worker_id
     and v_msg.turn_id = p_turn_id then
    update dental_leads.messages
       set send_status = p_result,
           provider_message_id = coalesce(p_provider_message_id, provider_message_id)
     where id = p_message_id;
    return jsonb_build_object('finalized', true, 'late', false);
  end if;

  -- O estado já mudou por outra via (reconciliado, ou nunca foi nosso).
  -- Confirmação tardia de entrega é informação valiosa — preserva sem
  -- reescrever o que já foi decidido.
  if p_result = 'SENT' then
    update dental_leads.messages
       set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
             'late_confirmation', jsonb_build_object(
               'result', p_result,
               'provider_message_id', p_provider_message_id,
               'observed_at', clock_timestamp(),
               'status_at_arrival', v_msg.send_status
             )
           )
     where id = p_message_id;
  end if;

  return jsonb_build_object(
    'finalized', false, 'late', true,
    'reason', 'estado_ja_mudou', 'current_status', v_msg.send_status
  );
end $$;

-- ============================================================================
-- reconcile_stuck_sending_bubbles — ganha SENDING_STALE_AFTER_MS.
--
-- Regra exata: uma bolha em SENDING só é reconciliada quando as DUAS
-- condições valem ao mesmo tempo:
--   (a) o job que a reservou não está mais RUNNING com o MESMO turn_id e
--       lease viva (condição já existente — cobre reclaim/crash/superação);
--   (b) já se passou SENDING_STALE_AFTER_MS desde que ela entrou em SENDING.
--
-- (b) existe separado de (a) de propósito: mesmo que o job já tenha perdido
-- o lease (por qualquer motivo, inclusive um lease que por acaso estava
-- quase vencendo no instante exato da transição), o POST original ainda
-- pode estar genuinamente em voo. SENDING_STALE_AFTER_MS precisa ser MAIOR
-- que EVOLUTION_TIMEOUT_MS com folga — por padrão,
-- EVOLUTION_TIMEOUT_MS + 30s (calculado em config.ts a partir do timeout
-- real configurado, não um número solto). Reconciliar antes disso arrisca
-- declarar UNKNOWN uma bolha que só está demorando dentro do normal.
-- ============================================================================
-- A versão anterior (0005) não tinha nenhum parâmetro. CREATE OR REPLACE só
-- substitui uma função de mesma assinatura — com um parâmetro novo (mesmo
-- com default), ela criaria um OVERLOAD ambíguo ao lado da antiga em vez de
-- substituí-la, quebrando toda chamada sem argumentos (Postgres não
-- consegue escolher entre as duas). DROP explícito evita isso.
drop function if exists dental_leads.reconcile_stuck_sending_bubbles();

create or replace function dental_leads.reconcile_stuck_sending_bubbles(
  p_stale_after_ms int default 45000
)
returns int
language plpgsql
security definer
set search_path = dental_leads, pg_temp
as $$
declare
  v_leads uuid[];
  v_count int;
begin
  with stuck as (
    update dental_leads.messages m
       set send_status = 'UNKNOWN'
     where m.send_status = 'SENDING'
       and m.sending_at is not null
       and m.sending_at <= now() - make_interval(secs => greatest(coalesce(p_stale_after_ms, 45000), 0) / 1000.0)
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
-- ingest_outbound_event — reconciliação de fromMe passa a recusar quando há
-- mais de um candidato plausível.
--
-- Ordem de correlação, na prioridade pedida:
--   1. provider_message_id exato (já existia — é o caminho normal quando a
--      Evolution devolveu o id no POST e o webhook chega depois);
--   2. correlação direta adicional da Evolution: NÃO existe hoje — esta
--      integração não envia (nem a Evolution aceita) um id de cliente
--      correlacionável no /message/sendText. Documentado aqui em vez de
--      fingir que existe; se a Evolution passar a suportar isso, é aqui que
--      entraria, antes do fallback por hash;
--   3. fallback por hash/texto, e SÓ quando o candidato é único dentro da
--      janela (mesmo lead, já era). Dois ou mais candidatos plausíveis =
--      não reconcilia automaticamente — marca a ambiguidade e needs_human.
-- ============================================================================
drop function if exists dental_leads.ingest_outbound_event(text,text,boolean,text,text,text,text,jsonb,timestamptz,int);

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
set search_path = dental_leads, pg_temp
as $$
declare
  v_lead      dental_leads.leads%rowtype;
  v_pending   uuid;
  v_candidate_count int;
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

  -- 1. provider_message_id exato.
  select id into v_pending
    from dental_leads.messages where provider_message_id = p_provider_message_id;

  if v_pending is not null then
    return jsonb_build_object('takeover', false, 'reason', 'known_message', 'lead_id', v_lead.id);
  end if;

  -- 2. correlação direta da Evolution: não disponível nesta integração hoje.

  -- 3. fallback por hash/texto — só se o candidato for único.
  select count(*) into v_candidate_count
    from dental_leads.messages
   where lead_id = v_lead.id
     and direction = 'OUT'
     and sender_type = 'AI'
     and provider_message_id is null
     and created_at > now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 120), 0))
     and (
       (p_content_hash is not null and content_hash = p_content_hash)
       or lower(btrim(coalesce(text, ''))) = lower(btrim(coalesce(p_text, '')))
     );

  if v_candidate_count = 1 then
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
       );

    update dental_leads.messages
       set provider_message_id = p_provider_message_id,
           send_status = 'SENT'
     where id = v_pending;
    return jsonb_build_object('takeover', false, 'reason', 'linked_pending', 'lead_id', v_lead.id);
  end if;

  if v_candidate_count > 1 then
    -- Ambíguo: dois ou mais candidatos plausíveis. Não escolher "o mais
    -- recente" às cegas — isso arrisca carimbar o id errado na bolha errada
    -- (corrompendo a auditoria e, pior, o rate limit que conta por turno).
    update dental_leads.leads
       set needs_human = true,
           automation_status = case
                                 when automation_status = 'ACTIVE' then 'HUMAN_REQUIRED'::automation_status
                                 else automation_status
                               end,
           human_reason = 'eco do WhatsApp ambíguo (mais de uma bolha recente com o mesmo texto) — conferir manualmente'
     where id = v_lead.id;
    return jsonb_build_object(
      'takeover', false, 'reason', 'ambiguous_echo', 'lead_id', v_lead.id, 'candidates', v_candidate_count
    );
  end if;

  -- Nenhum candidato: humano respondeu pelo WhatsApp de verdade.
  insert into dental_leads.messages (
    lead_id, provider_message_id, direction, sender_type, message_type, text,
    meta, provider_timestamp, received_at, content_hash, send_status, created_at
  )
  values (
    v_lead.id, p_provider_message_id, 'OUT', 'HUMAN', coalesce(p_message_type, 'TEXT'), p_text,
    p_meta, p_occurred_at, now(), p_content_hash, 'SENT', coalesce(p_occurred_at, now())
  )
  on conflict (provider_message_id) do nothing;

  update dental_leads.leads
     set automation_status = 'HUMAN_TAKEOVER',
         human_reason      = 'humano respondeu pelo WhatsApp',
         last_message_at   = greatest(coalesce(last_message_at, to_timestamp(0)), coalesce(p_occurred_at, now())),
         last_outbound_at  = greatest(coalesce(last_outbound_at, to_timestamp(0)), coalesce(p_occurred_at, now()))
   where id = v_lead.id;

  update dental_leads.jobs
     set status = 'DONE', outcome = 'HUMAN_TAKEOVER', last_error = 'cancelado por human takeover'
   where lead_id = v_lead.id and status = 'PENDING';

  return jsonb_build_object('takeover', true, 'reason', 'human_reply', 'lead_id', v_lead.id);
end $$;

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
revoke all on function dental_leads.reserve_outbound_bubble(bigint,text,uuid,bigint,uuid[],text,uuid,int,text,text,int) from public, anon, authenticated;
revoke all on function dental_leads.advance_bubble_to_sending(uuid,bigint,text,uuid,uuid,bigint,uuid[],text) from public, anon, authenticated;
revoke all on function dental_leads.finalize_bubble_send(uuid,bigint,text,uuid,send_status,text) from public, anon, authenticated;
revoke all on function dental_leads.reconcile_stuck_sending_bubbles(int) from public, anon, authenticated;
revoke all on function dental_leads.ingest_outbound_event(text,text,boolean,text,text,text,text,jsonb,timestamptz,int,text) from public, anon, authenticated;
