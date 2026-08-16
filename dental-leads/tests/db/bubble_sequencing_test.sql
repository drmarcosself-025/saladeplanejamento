-- ============================================================================
-- F2 — testes do motor de sequência de bolhas (SENDING, fencing por turn_id,
-- reconciliação, CANCELLED só a partir de PENDING, UNIQUE (turn_id,
-- bubble_sequence)).
--
-- Requer 0001, 0003, 0004 e 0005 já aplicadas.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/bubble_sequencing_test.sql
-- Sucesso = "TODOS OS CASOS PASSARAM" no final.
-- ============================================================================

begin;

do $$
declare
  v_lead    uuid;
  v_lead2   uuid;
  v_job     bigint;
  v_job2    bigint;
  v_turn    uuid;
  v_turn2   uuid;
  v_result  jsonb;
  v_msg     uuid;
  v_msg2    uuid;
  v_msg3    uuid;
  v_count   int;
  v_rev     bigint;
begin
  -- ---------------------------------------------------------------------
  -- Setup: um lead com uma mensagem, turno claimado.
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999991001@s.whatsapp.net', '5511999991001', false, 'Bolhas',
    'B-MSG-1', 'TEXT', 'Oi, quero saber de Invisalign', '{}'::jsonb, now(), 'b-hash-1', null, null, false, null, 5, 30);
  v_lead := (v_result->>'lead_id')::uuid;
  v_rev := (v_result->>'revision')::bigint;

  update public.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from public.claim_lead_jobs('worker-A', 5, 120);

  -- ---------------------------------------------------------------------
  -- 1. reserve → advance (SENDING) → SENT: o caminho feliz de uma bolha.
  -- ---------------------------------------------------------------------
  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => v_rev, p_batch_ids => (select array_agg(id) from public.messages where lead_id=v_lead and direction='IN'),
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Claro 😊', p_content_hash => 'hash-bolha-a', p_dedupe_seconds => 120);
  if not (v_result->>'reserved')::boolean then
    raise exception 'CASO 1a: reserva deveria ter sucesso (%)', v_result->>'reason';
  end if;
  v_msg := (v_result->>'message_id')::uuid;

  if (select send_status from public.messages where id = v_msg) <> 'PENDING' then
    raise exception 'CASO 1b: bolha recém-reservada deveria estar PENDING';
  end if;
  if (select reserved_job_id from public.messages where id = v_msg) <> v_job
     or (select reserved_worker_id from public.messages where id = v_msg) <> 'worker-A' then
    raise exception 'CASO 1c: reserved_job_id/reserved_worker_id deveriam estar gravados (auditoria)';
  end if;

  v_result := public.advance_bubble_to_sending(
    p_message_id => v_msg, p_job_id => v_job, p_worker_id => 'worker-A', p_turn_id => v_turn,
    p_lead_id => v_lead, p_input_revision => v_rev,
    p_batch_ids => (select array_agg(id) from public.messages where lead_id=v_lead and direction='IN'),
    p_purpose => 'AI_REPLY');
  if not (v_result->>'advanced')::boolean then
    raise exception 'CASO 1d: avanço para SENDING deveria ter sucesso (%)', v_result->>'reason';
  end if;
  if (select send_status from public.messages where id = v_msg) <> 'SENDING' then
    raise exception 'CASO 1e: bolha deveria estar SENDING depois do advance';
  end if;

  -- simula o resultado do POST (o worker faria isso após sendText)
  update public.messages set send_status = 'SENT', provider_message_id = 'EVO-ID-1' where id = v_msg;

  -- ---------------------------------------------------------------------
  -- 2. CANCELLED só a partir de PENDING: uma bolha já SENDING (ou SENT) NÃO
  --    pode ser cancelada por cancel_reserved_bubble.
  -- ---------------------------------------------------------------------
  if public.cancel_reserved_bubble(v_msg, v_job, 'worker-A', v_turn, 'tentativa_invalida') then
    raise exception 'CASO 2: bolha já SENT nunca pode ser cancelada (só PENDING vira CANCELLED)';
  end if;
  if (select send_status from public.messages where id = v_msg) <> 'SENT' then
    raise exception 'CASO 2: send_status não deveria ter mudado';
  end if;

  perform public.close_turn(v_job, 'worker-A', 'COMPLETED', array(select id from public.messages where lead_id=v_lead and direction='IN'), true, null, 4, 120);

  -- ---------------------------------------------------------------------
  -- 3. UNIQUE (turn_id, bubble_sequence): não dá pra reservar duas bolhas
  --    com a mesma sequência no mesmo turno.
  -- ---------------------------------------------------------------------
  -- (defesa: fecha qualquer PENDING remanescente de um ingest_inbound_message
  --  anterior, para o insert manual abaixo nunca colidir com o índice único)
  update public.jobs set status = 'DONE', outcome = 'SUPERSEDED', locked_by = null, lease_expires_at = null
   where lead_id = v_lead and status = 'PENDING';

  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  select job_id, turn_id into v_job, v_turn from public.claim_lead_jobs('worker-A', 5, 120);

  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => v_rev, p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'primeira', p_content_hash => 'hash-seq-1a', p_dedupe_seconds => 120);
  if not (v_result->>'reserved')::boolean then
    raise exception 'CASO 3a: primeira reserva da sequência 1 deveria funcionar (%)', v_result->>'reason';
  end if;

  begin
    perform public.reserve_outbound_bubble(
      p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
      p_input_revision => v_rev, p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
      p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
      p_text => 'texto diferente mas mesma sequencia', p_content_hash => 'hash-seq-1b', p_dedupe_seconds => 120);
    raise exception 'CASO 3b: segunda reserva com a MESMA (turn_id, sequence) deveria violar o índice único';
  exception when unique_violation then
    null; -- esperado
  end;

  perform public.close_turn(v_job, 'worker-A', 'NO_REPLY', array[]::uuid[], false, null, 4, 120);

  -- ---------------------------------------------------------------------
  -- 4. Perda de lease ENTRE reserva e envio: advance_bubble_to_sending
  --    recusa e cancela a bolha (PENDING → CANCELLED), nunca deixa passar.
  -- ---------------------------------------------------------------------
  -- (defesa: fecha qualquer PENDING remanescente de um ingest_inbound_message
  --  anterior, para o insert manual abaixo nunca colidir com o índice único)
  update public.jobs set status = 'DONE', outcome = 'SUPERSEDED', locked_by = null, lease_expires_at = null
   where lead_id = v_lead and status = 'PENDING';

  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  select job_id, turn_id into v_job, v_turn from public.claim_lead_jobs('worker-A', 5, 120);

  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => v_rev, p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'vou perder o lease', p_content_hash => 'hash-lease-perdido', p_dedupe_seconds => 120);
  v_msg := (v_result->>'message_id')::uuid;

  -- simula lease vencido (ex.: worker travou entre a reserva e o envio)
  update public.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;

  v_result := public.advance_bubble_to_sending(
    p_message_id => v_msg, p_job_id => v_job, p_worker_id => 'worker-A', p_turn_id => v_turn,
    p_lead_id => v_lead, p_input_revision => v_rev, p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY');
  if (v_result->>'advanced')::boolean then
    raise exception 'CASO 4a: lease vencido entre reserva e envio NUNCA pode avançar pra SENDING';
  end if;
  if (v_result->>'reason') <> 'lease_perdido' then
    raise exception 'CASO 4b: motivo esperado lease_perdido, veio %', v_result->>'reason';
  end if;
  if (select send_status from public.messages where id = v_msg) <> 'CANCELLED' then
    raise exception 'CASO 4c: a bolha deveria ter sido cancelada automaticamente';
  end if;

  update public.jobs set status='DONE', outcome='FAILED', locked_by=null, lease_expires_at=null where id = v_job;

  -- ---------------------------------------------------------------------
  -- 5. Nova mensagem chega DEPOIS que a bolha 2 foi reservada (com a
  --    revisão ainda válida naquele instante) mas ANTES do advance
  --    (checkpoint imediatamente antes do POST). O reserve não tem como
  --    prever o futuro — quem barra é o advance, e cancela a bolha.
  -- ---------------------------------------------------------------------
  -- (defesa: fecha qualquer PENDING remanescente de um ingest_inbound_message
  --  anterior, para o insert manual abaixo nunca colidir com o índice único)
  update public.jobs set status = 'DONE', outcome = 'SUPERSEDED', locked_by = null, lease_expires_at = null
   where lead_id = v_lead and status = 'PENDING';

  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  select job_id, turn_id into v_job, v_turn from public.claim_lead_jobs('worker-A', 5, 120);

  declare
    v_rev_no_momento_da_bolha_1 bigint := (select conversation_revision from public.leads where id = v_lead);
  begin
    -- bolha 1: sai normalmente
    v_result := public.reserve_outbound_bubble(
      p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
      p_input_revision => v_rev_no_momento_da_bolha_1, p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
      p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
      p_text => 'bolha 1 desta sequencia', p_content_hash => 'hash-entre-bolhas-1', p_dedupe_seconds => 120);
    v_msg := (v_result->>'message_id')::uuid;
    perform public.advance_bubble_to_sending(v_msg, v_job, 'worker-A', v_turn, v_lead,
      v_rev_no_momento_da_bolha_1,
      (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
      'AI_REPLY');
    update public.messages set send_status = 'SENT', provider_message_id = 'EVO-ID-ENTRE-1' where id = v_msg;

    -- bolha 2: reservada AINDA com a revisão válida (nada mudou até aqui)
    v_result := public.reserve_outbound_bubble(
      p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
      p_input_revision => v_rev_no_momento_da_bolha_1, p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
      p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 2,
      p_text => 'bolha 2 vai ficar obsoleta', p_content_hash => 'hash-entre-bolhas-2', p_dedupe_seconds => 120);
    if not (v_result->>'reserved')::boolean then
      raise exception 'CASO 5a: reserva da bolha 2 deveria funcionar (revisão ainda não mudou) (%)', v_result->>'reason';
    end if;
    v_msg2 := (v_result->>'message_id')::uuid;

    -- SÓ AGORA o lead manda mensagem nova (entre a reserva e o advance da bolha 2)
    v_result := public.ingest_inbound_message(
      '5511999991001@s.whatsapp.net', '5511999991001', false, 'Bolhas',
      'B-MSG-2', 'TEXT', 'na verdade quero marcar', '{}'::jsonb, now(), 'b-hash-2', null, null, false, null, 5, 30);

    -- advance da bolha 2 usa a MESMA revisão com que foi reservada (o worker
    -- não tem como saber da mensagem nova sozinho) — é exatamente esse
    -- descompasso que o advance precisa flagrar
    v_result := public.advance_bubble_to_sending(
      p_message_id => v_msg2, p_job_id => v_job, p_worker_id => 'worker-A', p_turn_id => v_turn,
      p_lead_id => v_lead, p_input_revision => v_rev_no_momento_da_bolha_1,
      p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY');
    if (v_result->>'advanced')::boolean then
      raise exception 'CASO 5b: mensagem nova entre reserva e advance DEVE impedir o avanço da bolha 2';
    end if;
    if (v_result->>'reason') <> 'stale_revision_mismatch' then
      raise exception 'CASO 5c: motivo esperado stale_revision_mismatch, veio %', v_result->>'reason';
    end if;
    if (select send_status from public.messages where id = v_msg2) <> 'CANCELLED' then
      raise exception 'CASO 5d: bolha 2 deveria estar CANCELLED';
    end if;
    -- e a bolha 1, que já tinha saído, continua SENT — não se desfaz o que
    -- já foi entregue
    if (select send_status from public.messages where id = v_msg) <> 'SENT' then
      raise exception 'CASO 5e: bolha 1 (já entregue) não pode ser afetada pelo que aconteceu depois';
    end if;
  end;

  update public.jobs set status='DONE', outcome='PARTIAL_STALE', locked_by=null, lease_expires_at=null where id = v_job;

  -- ---------------------------------------------------------------------
  -- 6. Takeover ENTRE bolhas: humano assume no meio da sequência.
  -- ---------------------------------------------------------------------
  -- (defesa: fecha qualquer PENDING remanescente de um ingest_inbound_message
  --  anterior, para o insert manual abaixo nunca colidir com o índice único)
  update public.jobs set status = 'DONE', outcome = 'SUPERSEDED', locked_by = null, lease_expires_at = null
   where lead_id = v_lead and status = 'PENDING';

  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  select job_id, turn_id into v_job, v_turn from public.claim_lead_jobs('worker-A', 5, 120);

  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => (select conversation_revision from public.leads where id = v_lead),
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'bolha antes do takeover', p_content_hash => 'hash-takeover-1', p_dedupe_seconds => 120);
  v_msg := (v_result->>'message_id')::uuid;
  perform public.advance_bubble_to_sending(v_msg, v_job, 'worker-A', v_turn, v_lead,
    (select conversation_revision from public.leads where id = v_lead),
    (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    'AI_REPLY');
  update public.messages set send_status = 'SENT', provider_message_id = 'EVO-ID-TAKEOVER-1' where id = v_msg;

  -- humano assume no meio da sequência
  update public.leads set automation_status = 'HUMAN_TAKEOVER' where id = v_lead;

  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => (select conversation_revision from public.leads where id = v_lead),
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 2,
    p_text => 'bolha depois do takeover', p_content_hash => 'hash-takeover-2', p_dedupe_seconds => 120);
  if (v_result->>'reserved')::boolean then
    raise exception 'CASO 6a: nenhuma bolha nova pode ser reservada depois do takeover';
  end if;
  if (v_result->>'reason') <> 'human_takeover' then
    raise exception 'CASO 6b: motivo esperado human_takeover, veio %', v_result->>'reason';
  end if;

  update public.leads set automation_status = 'ACTIVE' where id = v_lead;
  update public.jobs set status='DONE', outcome='HUMAN_TAKEOVER', locked_by=null, lease_expires_at=null where id = v_job;

  -- ---------------------------------------------------------------------
  -- 7. Crash depois de SENDING e antes do fetch (nunca soubemos o
  --    resultado): reconcile_stuck_sending_bubbles vira UNKNOWN quando o
  --    lease morre, e marca o lead needs_human.
  -- ---------------------------------------------------------------------
  -- (defesa: fecha qualquer PENDING remanescente de um ingest_inbound_message
  --  anterior, para o insert manual abaixo nunca colidir com o índice único)
  update public.jobs set status = 'DONE', outcome = 'SUPERSEDED', locked_by = null, lease_expires_at = null
   where lead_id = v_lead and status = 'PENDING';

  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  select job_id, turn_id into v_job, v_turn from public.claim_lead_jobs('worker-A', 5, 120);

  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => (select conversation_revision from public.leads where id = v_lead),
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'travou logo depois do POST', p_content_hash => 'hash-crash-sending', p_dedupe_seconds => 120);
  v_msg := (v_result->>'message_id')::uuid;
  perform public.advance_bubble_to_sending(v_msg, v_job, 'worker-A', v_turn, v_lead,
    (select conversation_revision from public.leads where id = v_lead),
    (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    'AI_REPLY');

  if (select send_status from public.messages where id = v_msg) <> 'SENDING' then
    raise exception 'CASO 7 setup: a bolha deveria estar SENDING antes de simular o crash';
  end if;

  -- Ainda com lease vivo: reconcile não deve mexer (o worker pode estar
  -- genuinamente no meio do POST).
  perform public.reconcile_stuck_sending_bubbles();
  if (select send_status from public.messages where id = v_msg) <> 'SENDING' then
    raise exception 'CASO 7a: bolha SENDING com lease vivo NÃO pode ser reconciliada ainda';
  end if;

  -- Worker morre (nunca mais renova) — simula lease vencido.
  update public.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;

  -- Desde a validação pré-F3 (SENDING_STALE_AFTER_MS): lease vencida sozinha
  -- não basta — o reconciler também exige que já tenha passado a margem
  -- desde sending_at (maior que o timeout normal do POST, pra não declarar
  -- abandonado um envio que só está demorando dentro do esperado). Aqui
  -- simulamos essa margem já vencida; o teste dedicado da margem em si está
  -- em prerelease_validation_test.sql (PONTO 3).
  update public.messages set sending_at = now() - interval '1 hour' where id = v_msg;

  if public.reconcile_stuck_sending_bubbles() < 1 then
    raise exception 'CASO 7b: bolha SENDING órfã deveria ser reconciliada';
  end if;
  if (select send_status from public.messages where id = v_msg) <> 'UNKNOWN' then
    raise exception 'CASO 7c: bolha travada em SENDING deveria virar UNKNOWN, nunca voltar a PENDING';
  end if;
  if not (select needs_human from public.leads where id = v_lead) then
    raise exception 'CASO 7d: lead deveria virar needs_human depois da reconciliação';
  end if;

  update public.leads set needs_human = false, automation_status = 'ACTIVE' where id = v_lead;
  update public.jobs set status='FAILED', outcome='FAILED', locked_by=null, lease_expires_at=null where id = v_job;

  -- ---------------------------------------------------------------------
  -- 8. Crash depois do POST 2xx e antes de marcar SENT: do ponto de vista
  --    do banco é EXATAMENTE o mesmo cenário do caso 7 (a bolha fica presa
  --    em SENDING porque o worker nunca voltou pra gravar o resultado —
  --    não importa se a Evolution respondeu 2xx ou nem respondeu ainda).
  --    Reafirma isso com um segundo lead, pra não depender de estado do
  --    caso 7.
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999991002@s.whatsapp.net', '5511999991002', false, 'Crash2xx',
    'C2-MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'c2-hash-1', null, null, false, null, 5, 30);
  v_lead2 := (v_result->>'lead_id')::uuid;
  update public.jobs set run_after = now() where lead_id = v_lead2 and status = 'PENDING';
  select job_id, turn_id into v_job2, v_turn2 from public.claim_lead_jobs('worker-B', 5, 120);

  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job2, p_worker_id => 'worker-B', p_lead_id => v_lead2,
    p_input_revision => (select conversation_revision from public.leads where id = v_lead2),
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead2 and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY', p_turn_id => v_turn2, p_sequence => 1,
    p_text => 'evolution aceitou mas eu morri', p_content_hash => 'hash-crash-2xx', p_dedupe_seconds => 120);
  v_msg2 := (v_result->>'message_id')::uuid;
  perform public.advance_bubble_to_sending(v_msg2, v_job2, 'worker-B', v_turn2, v_lead2,
    (select conversation_revision from public.leads where id = v_lead2),
    (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead2 and direction = 'IN' and consumed_at is null),
    'AI_REPLY');
  -- (a Evolution teria respondido 2xx aqui — o worker morre antes de rodar
  -- o UPDATE que gravaria send_status='SENT' e o provider_message_id)

  update public.jobs set lease_expires_at = now() - interval '1 second' where id = v_job2;
  update public.messages set sending_at = now() - interval '1 hour' where id = v_msg2;
  perform public.reconcile_stuck_sending_bubbles();

  if (select send_status from public.messages where id = v_msg2) <> 'UNKNOWN' then
    raise exception 'CASO 8: bolha aceita pela Evolution mas nunca confirmada deveria virar UNKNOWN, não SENT nem PENDING';
  end if;

  -- ---------------------------------------------------------------------
  -- 9. Reconciliação de UNKNOWN via fromMe: o eco chega depois e a bolha
  --    volta a SENT com o provider_message_id de verdade — sem reenviar
  --    nada, só corrigindo o registro.
  -- ---------------------------------------------------------------------
  v_result := public.ingest_outbound_event(
    '5511999991002@s.whatsapp.net', '5511999991002', false, 'Crash2xx',
    'EVO-ID-TARDIO', 'TEXT', 'evolution aceitou mas eu morri', '{}'::jsonb, now(), 120, 'hash-crash-2xx');
  if (v_result->>'takeover')::boolean then
    raise exception 'CASO 9a: o eco tardio de uma bolha nossa NUNCA pode virar takeover';
  end if;
  if (select send_status from public.messages where id = v_msg2) <> 'SENT' then
    raise exception 'CASO 9b: a reconciliação via fromMe deveria trazer a bolha de volta a SENT';
  end if;
  if (select provider_message_id from public.messages where id = v_msg2) <> 'EVO-ID-TARDIO' then
    raise exception 'CASO 9c: o provider_message_id deveria ter sido carimbado retroativamente';
  end if;

  update public.leads set needs_human = false, automation_status = 'ACTIVE' where id = v_lead2;
  update public.jobs set status='FAILED', outcome='FAILED', locked_by=null, lease_expires_at=null where id = v_job2;

  -- ---------------------------------------------------------------------
  -- 10. cancel_reserved_bubble é idempotente e exige job+worker+turn_id.
  -- ---------------------------------------------------------------------
  -- (defesa: fecha qualquer PENDING remanescente de um ingest_inbound_message
  --  anterior, para o insert manual abaixo nunca colidir com o índice único)
  update public.jobs set status = 'DONE', outcome = 'SUPERSEDED', locked_by = null, lease_expires_at = null
   where lead_id = v_lead and status = 'PENDING';

  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  select job_id, turn_id into v_job, v_turn from public.claim_lead_jobs('worker-A', 5, 120);

  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => (select conversation_revision from public.leads where id = v_lead),
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from public.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'vou ser cancelada', p_content_hash => 'hash-cancel-idemp', p_dedupe_seconds => 120);
  v_msg := (v_result->>'message_id')::uuid;

  -- fencing errado (turn_id errado) não cancela nada
  if public.cancel_reserved_bubble(v_msg, v_job, 'worker-A', gen_random_uuid(), 'motivo') then
    raise exception 'CASO 10a: turn_id errado nunca pode cancelar (fencing)';
  end if;
  -- worker errado não cancela
  if public.cancel_reserved_bubble(v_msg, v_job, 'worker-intruso', v_turn, 'motivo') then
    raise exception 'CASO 10b: worker_id errado nunca pode cancelar';
  end if;

  if not public.cancel_reserved_bubble(v_msg, v_job, 'worker-A', v_turn, 'motivo_valido') then
    raise exception 'CASO 10c: cancelamento com credenciais corretas deveria funcionar';
  end if;
  if (select send_status from public.messages where id = v_msg) <> 'CANCELLED' then
    raise exception 'CASO 10d: bolha deveria estar CANCELLED';
  end if;

  -- idempotente: segunda chamada não erra, só devolve false (já não é PENDING)
  if public.cancel_reserved_bubble(v_msg, v_job, 'worker-A', v_turn, 'motivo_valido_de_novo') then
    raise exception 'CASO 10e: cancelar uma bolha já CANCELLED deveria devolver false, não repetir a ação';
  end if;

  perform public.close_turn(v_job, 'worker-A', 'STALE_BEFORE_SEND', array[]::uuid[], false, null, 4, 120);

  -- ---------------------------------------------------------------------
  -- 11. yield_turn: só o dono do lease cede; job volta pra PENDING na hora,
  --     sem gastar tentativa (attempts intocado).
  -- ---------------------------------------------------------------------
  update public.jobs set status = 'DONE', outcome = 'SUPERSEDED', locked_by = null, lease_expires_at = null
   where lead_id = v_lead and status = 'PENDING';

  insert into public.jobs (lead_id, status, debounce_started_at, run_after, attempts)
  values (v_lead, 'PENDING', now(), now(), 1) returning id into v_job;
  select job_id, attempts into v_job, v_count from public.claim_lead_jobs('worker-A', 5, 120);
  -- attempts foi incrementado pelo claim (2 agora)

  if public.yield_turn(v_job, 'worker-intruso') then
    raise exception 'CASO 11a: worker que não é dono do lease não pode ceder o turno';
  end if;

  if not public.yield_turn(v_job, 'worker-A') then
    raise exception 'CASO 11b: o dono do lease deveria conseguir ceder';
  end if;

  if (select status from public.jobs where id = v_job) <> 'PENDING' then
    raise exception 'CASO 11c: job cedido deveria voltar pra PENDING imediatamente';
  end if;
  if (select run_after from public.jobs where id = v_job) > now() then
    raise exception 'CASO 11d: job cedido deveria estar pronto pra ser pego na hora (run_after <= agora)';
  end if;
  if (select outcome from public.jobs where id = v_job) <> 'YIELDED' then
    raise exception 'CASO 11e: outcome deveria ser YIELDED, não FAILED (não é erro)';
  end if;
  if (select attempts from public.jobs where id = v_job) <> v_count then
    raise exception 'CASO 11f: yield não pode gastar tentativa (attempts deveria continuar %, está %)', v_count, (select attempts from public.jobs where id = v_job);
  end if;

  update public.jobs set status='DONE' where id = v_job;

  -- ---------------------------------------------------------------------
  -- 12. Item 1 da revisão, confirmado explicitamente: reclaim de um job
  --     superado NUNCA marca o lead como needs_human, e o outcome é
  --     SUPERSEDED (não FAILED).
  -- ---------------------------------------------------------------------
  insert into public.jobs (lead_id, status, debounce_started_at, run_after,
                           locked_by, lease_expires_at)
  values (v_lead, 'RUNNING', now() - interval '200 seconds', now() - interval '200 seconds',
          'worker-antigo', now() - interval '80 seconds')
  returning id into v_job;

  v_result := public.ingest_inbound_message(
    '5511999991001@s.whatsapp.net', '5511999991001', false, 'Bolhas',
    'B-MSG-SUPERSEDE', 'TEXT', 'oi de novo', '{}'::jsonb, now(), 'b-hash-supersede', null, null, false, null, 5, 30);

  perform public.reclaim_expired_jobs();

  if (select status from public.jobs where id = v_job) <> 'DONE' then
    raise exception 'CASO 12a: job superado deveria estar DONE';
  end if;
  if (select outcome from public.jobs where id = v_job) <> 'SUPERSEDED' then
    raise exception 'CASO 12b: outcome deveria ser SUPERSEDED, nunca FAILED — não houve erro nenhum';
  end if;
  if (select needs_human from public.leads where id = v_lead) then
    raise exception 'CASO 12c: reclaim de job superado NUNCA pode marcar o lead como needs_human';
  end if;

  update public.jobs set status='DONE' where lead_id = v_lead and status='PENDING';

  -- ---------------------------------------------------------------------
  -- 13. Item 2 da revisão, confirmado explicitamente: reentrega do webhook
  --     não incrementa conversation_revision. Isolado, sem depender de
  --     outros casos.
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999991003@s.whatsapp.net', '5511999991003', false, 'Revisao',
    'REV-MSG-1', 'TEXT', 'primeira mensagem', '{}'::jsonb, now(), 'rev-hash-1', null, null, false, null, 5, 30);
  v_rev := (v_result->>'revision')::bigint;
  if v_rev <> 1 then
    raise exception 'CASO 13a: primeira mensagem genuína deveria levar a revisão a 1';
  end if;

  -- reentrega do MESMO provider_message_id, três vezes seguidas
  for i in 1..3 loop
    v_result := public.ingest_inbound_message(
      '5511999991003@s.whatsapp.net', '5511999991003', false, 'Revisao',
      'REV-MSG-1', 'TEXT', 'primeira mensagem', '{}'::jsonb, now(), 'rev-hash-1', null, null, false, null, 5, 30);
    if not (v_result->>'duplicate')::boolean then
      raise exception 'CASO 13b: reentrega % deveria ser reconhecida como duplicata', i;
    end if;
  end loop;

  if (select conversation_revision from public.leads where whatsapp_id = '5511999991003@s.whatsapp.net') <> 1 then
    raise exception 'CASO 13c: 3 reentregas do MESMO provider_message_id não podem incrementar a revisão (deveria continuar 1)';
  end if;

  raise notice 'TODOS OS CASOS PASSARAM';
end $$;

rollback;
