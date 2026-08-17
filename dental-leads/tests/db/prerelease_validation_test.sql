-- ============================================================================
-- Validação final pré-F3 — os quatro pontos pedidos, cada um com teste
-- explícito contra Postgres real.
--
-- Requer 0001, 0003, 0004, 0005 e 0006 já aplicadas.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/prerelease_validation_test.sql
-- Sucesso = "TODOS OS CASOS PASSARAM" no final.
-- ============================================================================

begin;
set search_path = dental_leads, public, extensions;

do $$
declare
  v_lead   uuid;
  v_job    bigint;
  v_turn   uuid;
  v_result jsonb;
  v_msg    uuid;
  v_msg2   uuid;
  v_msgA   uuid;
  v_msgB   uuid;
  v_rev1   bigint;
  v_rev2   bigint;
  v_count  int;
begin
  -- ---------------------------------------------------------------------
  -- PONTO 1 — dedupe por content_hash não pode impedir texto idêntico em
  -- turnos GENUINAMENTE diferentes. "Perfeito 😊" às 10:00 e de novo às
  -- 10:30 são turnos distintos (cada um só existe porque uma mensagem nova
  -- chegou, o que sempre incrementa a revisão) — os dois devem virar SENT.
  -- ---------------------------------------------------------------------
  v_result := dental_leads.ingest_inbound_message(
    '5511999992001@s.whatsapp.net', '5511999992001', false, 'Dedupe',
    'DED-MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'ded-hash-1', null, null, false, null, 5, 30);
  v_lead := (v_result->>'lead_id')::uuid;
  v_rev1 := (v_result->>'revision')::bigint;

  update dental_leads.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from dental_leads.claim_lead_jobs('worker-A', 5, 120);

  -- Turno 1 (10:00): reserva, avança, envia "Perfeito 😊".
  v_result := dental_leads.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => v_rev1,
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Perfeito 😊', p_content_hash => 'hash-perfeito', p_dedupe_seconds => 120);
  if not (v_result->>'reserved')::boolean then
    raise exception 'PONTO1a: primeira reserva de "Perfeito 😊" deveria funcionar (%)', v_result->>'reason';
  end if;
  v_msgA := (v_result->>'message_id')::uuid;

  perform dental_leads.advance_bubble_to_sending(v_msgA, v_job, 'worker-A', v_turn, v_lead, v_rev1,
    (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    'AI_REPLY');
  v_result := dental_leads.finalize_bubble_send(v_msgA, v_job, 'worker-A', v_turn, 'SENT', 'EVO-DED-1');
  if not (v_result->>'finalized')::boolean then
    raise exception 'PONTO1b: finalize do turno 1 deveria aplicar (%)', v_result;
  end if;
  if (select send_status from dental_leads.messages where id = v_msgA) <> 'SENT' then
    raise exception 'PONTO1c: bolha do turno 1 deveria estar SENT';
  end if;

  perform dental_leads.close_turn(v_job, 'worker-A', 'COMPLETED',
    array(select id from dental_leads.messages where lead_id = v_lead and direction = 'IN'), true, null, 4, 120);

  -- 30 minutos depois: mensagem nova chega (é isso que legitima um turno
  -- novo — sem ela o batch estaria vazio e nem chamaria IA). Revisão sobe.
  v_result := dental_leads.ingest_inbound_message(
    '5511999992001@s.whatsapp.net', '5511999992001', false, 'Dedupe',
    'DED-MSG-2', 'TEXT', 'Ainda por aí?', '{}'::jsonb, now(), 'ded-hash-2', null, null, false, null, 5, 30);
  v_rev2 := (v_result->>'revision')::bigint;
  if v_rev2 = v_rev1 then
    raise exception 'PONTO1d: mensagem nova deveria incrementar a revisão (era %, continua %)', v_rev1, v_rev2;
  end if;

  update dental_leads.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from dental_leads.claim_lead_jobs('worker-A', 5, 120);

  -- Turno 2 (10:30): a IA, por coincidência, também diz "Perfeito 😊" —
  -- mesmo hash, revisão DIFERENTE. Não pode ser barrado como duplicata.
  v_result := dental_leads.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => v_rev2,
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Perfeito 😊', p_content_hash => 'hash-perfeito', p_dedupe_seconds => 120);
  if not (v_result->>'reserved')::boolean then
    raise exception 'PONTO1e: "Perfeito 😊" num turno genuinamente novo NÃO pode ser barrado como duplicata (%)', v_result->>'reason';
  end if;
  v_msgB := (v_result->>'message_id')::uuid;

  perform dental_leads.advance_bubble_to_sending(v_msgB, v_job, 'worker-A', v_turn, v_lead, v_rev2,
    (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    'AI_REPLY');
  v_result := dental_leads.finalize_bubble_send(v_msgB, v_job, 'worker-A', v_turn, 'SENT', 'EVO-DED-2');
  if not (v_result->>'finalized')::boolean then
    raise exception 'PONTO1f: finalize do turno 2 deveria aplicar (%)', v_result;
  end if;

  -- Os dois SENT, de verdade, nenhum dos dois "engolido" pelo dedupe.
  select count(*) into v_count from dental_leads.messages
   where lead_id = v_lead and content_hash = 'hash-perfeito' and send_status = 'SENT';
  if v_count <> 2 then
    raise exception 'PONTO1g: as duas mensagens "Perfeito 😊" (turnos diferentes) deveriam estar SENT, contei %', v_count;
  end if;

  perform dental_leads.close_turn(v_job, 'worker-A', 'COMPLETED',
    array(select id from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), true, null, 4, 120);

  -- Confere também: DENTRO do mesmo turno/revisão retomado (zombie real),
  -- o dedupe CONTINUA bloqueando — não regredimos a proteção original.
  update dental_leads.jobs set status = 'DONE' where lead_id = v_lead and status = 'PENDING';
  insert into dental_leads.jobs (lead_id, status, debounce_started_at, run_after) values (v_lead, 'PENDING', now(), now());
  update dental_leads.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from dental_leads.claim_lead_jobs('worker-A', 5, 120);

  v_result := dental_leads.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => v_rev2,  -- MESMA revisão do turno anterior (zombie retomando o mesmo batch)
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Perfeito 😊', p_content_hash => 'hash-perfeito', p_dedupe_seconds => 120);
  if (v_result->>'reserved')::boolean then
    raise exception 'PONTO1h: mesma revisão + mesmo hash + já SENT precisa continuar bloqueado (retry de zumbi)';
  end if;
  if (v_result->>'reason') <> 'duplicado' then
    raise exception 'PONTO1i: motivo esperado duplicado, veio %', v_result->>'reason';
  end if;

  update dental_leads.jobs set status = 'DONE' where lead_id = v_lead and status = 'RUNNING';

  raise notice 'PONTO 1 OK: dedupe escopado por revisão — turnos diferentes passam, zumbi do mesmo turno continua bloqueado';

  -- ---------------------------------------------------------------------
  -- PONTO 2 — reconciliação de fromMe ambígua: 2+ candidatos plausíveis
  -- NÃO podem ser resolvidos escolhendo "o mais recente" às cegas.
  -- ---------------------------------------------------------------------
  v_result := dental_leads.ingest_inbound_message(
    '5511999992002@s.whatsapp.net', '5511999992002', false, 'Ambiguo',
    'AMB-MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'amb-hash-1', null, null, false, null, 5, 30);
  v_lead := (v_result->>'lead_id')::uuid;
  v_rev1 := (v_result->>'revision')::bigint;
  update dental_leads.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from dental_leads.claim_lead_jobs('worker-A', 5, 120);

  -- Duas bolhas OUT pendentes de id, mesmo texto, mesmo lead, dentro da
  -- janela de graça — cenário real: a IA respondeu duas vezes algo curto e
  -- genérico ("Perfeito 😊") em bolhas diferentes, ou um replay de teste.
  insert into dental_leads.messages (lead_id, direction, sender_type, message_type, text,
                               content_hash, send_status, turn_id, bubble_sequence,
                               reserved_job_id, reserved_worker_id, reservation_revision, created_at)
  values
    (v_lead, 'OUT', 'AI', 'TEXT', 'Perfeito 😊', 'hash-ambiguo', 'SENDING', v_turn, 1, v_job, 'worker-A', v_rev1, now() - interval '5 seconds'),
    (v_lead, 'OUT', 'AI', 'TEXT', 'Perfeito 😊', 'hash-ambiguo', 'SENDING', v_turn, 2, v_job, 'worker-A', v_rev1, now() - interval '3 seconds');

  v_result := dental_leads.ingest_outbound_event(
    '5511999992002@s.whatsapp.net', '5511999992002', false, 'Ambiguo',
    'EVO-AMBIGUO-1', 'TEXT', 'Perfeito 😊', '{}'::jsonb, now(), 120, 'hash-ambiguo');

  if (v_result->>'takeover')::boolean then
    raise exception 'PONTO2a: eco ambíguo não pode virar takeover (pode ser eco de bolha nossa, só não sabemos qual)';
  end if;
  if (v_result->>'reason') <> 'ambiguous_echo' then
    raise exception 'PONTO2b: motivo esperado ambiguous_echo, veio %', v_result->>'reason';
  end if;
  if (v_result->>'candidates')::int <> 2 then
    raise exception 'PONTO2c: deveria reportar 2 candidatos, veio %', v_result->>'candidates';
  end if;

  -- Nenhuma das duas foi tocada — nem ganhou provider_message_id, nem
  -- mudou de status por adivinhação.
  select count(*) into v_count from dental_leads.messages
   where lead_id = v_lead and content_hash = 'hash-ambiguo' and provider_message_id is not null;
  if v_count <> 0 then
    raise exception 'PONTO2d: nenhuma bolha ambígua pode ter sido carimbada com o id do evento';
  end if;

  if not (select needs_human from dental_leads.leads where id = v_lead) then
    raise exception 'PONTO2e: ambiguidade precisa marcar o lead como needs_human';
  end if;

  raise notice 'PONTO 2 OK: eco ambíguo (2+ candidatos) recusa reconciliação automática, marca needs_human';

  -- Confirma o caminho feliz continua funcionando: candidato ÚNICO reconcilia normalmente.
  update dental_leads.leads set needs_human = false, automation_status = 'ACTIVE' where id = v_lead;
  update dental_leads.jobs set status = 'DONE', locked_by = null, lease_expires_at = null where lead_id = v_lead and status = 'RUNNING';

  v_result := dental_leads.ingest_inbound_message(
    '5511999992003@s.whatsapp.net', '5511999992003', false, 'Unico',
    'UNI-MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'uni-hash-1', null, null, false, null, 5, 30);
  v_lead := (v_result->>'lead_id')::uuid;
  v_rev1 := (v_result->>'revision')::bigint;
  update dental_leads.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from dental_leads.claim_lead_jobs('worker-B', 5, 120);

  insert into dental_leads.messages (lead_id, direction, sender_type, message_type, text,
                               content_hash, send_status, turn_id, bubble_sequence,
                               reserved_job_id, reserved_worker_id, reservation_revision, created_at)
  values (v_lead, 'OUT', 'AI', 'TEXT', 'Claro 😊', 'hash-unico', 'SENDING', v_turn, 1, v_job, 'worker-B', v_rev1, now())
  returning id into v_msg;

  v_result := dental_leads.ingest_outbound_event(
    '5511999992003@s.whatsapp.net', '5511999992003', false, 'Unico',
    'EVO-UNICO-1', 'TEXT', 'Claro 😊', '{}'::jsonb, now(), 120, 'hash-unico');

  if (v_result->>'reason') <> 'linked_pending' then
    raise exception 'PONTO2f: candidato único deveria reconciliar normalmente, veio %', v_result->>'reason';
  end if;
  if (select provider_message_id from dental_leads.messages where id = v_msg) <> 'EVO-UNICO-1' then
    raise exception 'PONTO2g: candidato único deveria ganhar o provider_message_id do evento';
  end if;

  raise notice 'PONTO 2 (caminho feliz) OK: candidato único continua reconciliando normalmente';

  update dental_leads.jobs set status = 'DONE', locked_by = null, lease_expires_at = null where lead_id = v_lead and status = 'RUNNING';

  -- ---------------------------------------------------------------------
  -- PONTO 3 — corrida SENDING / reconciler / HTTP tardio. Worker A grava
  -- SENDING, lease expira, reconciler declara UNKNOWN, DEPOIS o POST
  -- original (que nunca soube da reconciliação) retorna 2xx. finalize_
  -- bubble_send não pode sobrescrever o UNKNOWN silenciosamente.
  -- ---------------------------------------------------------------------
  v_result := dental_leads.ingest_inbound_message(
    '5511999992004@s.whatsapp.net', '5511999992004', false, 'Corrida',
    'COR-MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'cor-hash-1', null, null, false, null, 5, 30);
  v_lead := (v_result->>'lead_id')::uuid;
  v_rev1 := (v_result->>'revision')::bigint;
  update dental_leads.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from dental_leads.claim_lead_jobs('worker-A', 5, 120);

  v_result := dental_leads.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => v_rev1, p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null),
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'POST em voo quando o lease morre', p_content_hash => 'hash-corrida', p_dedupe_seconds => 120);
  v_msg := (v_result->>'message_id')::uuid;

  perform dental_leads.advance_bubble_to_sending(v_msg, v_job, 'worker-A', v_turn, v_lead, v_rev1, (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), 'AI_REPLY');
  if (select send_status from dental_leads.messages where id = v_msg) <> 'SENDING' then
    raise exception 'PONTO3 setup: bolha deveria estar SENDING';
  end if;

  -- Lease expira ENQUANTO o POST (hipoteticamente) ainda está em voo.
  update dental_leads.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;

  -- Mesmo com o lease já vencido, a bolha acabou de entrar em SENDING —
  -- ainda dentro da margem (bem menor que os 45000ms de
  -- SENDING_STALE_AFTER_MS default). O reconciler NÃO pode declará-la
  -- abandonada: o POST original pode genuinamente ainda estar em voo,
  -- dentro do timeout normal da Evolution.
  if dental_leads.reconcile_stuck_sending_bubbles(45000) > 0
     and (select send_status from dental_leads.messages where id = v_msg) = 'UNKNOWN' then
    raise exception 'PONTO3a0: bolha SENDING recente (dentro da margem) NÃO pode ser reconciliada antes do tempo, mesmo com lease vencido';
  end if;
  if (select send_status from dental_leads.messages where id = v_msg) <> 'SENDING' then
    raise exception 'PONTO3a0b: bolha deveria continuar SENDING (ainda dentro da margem de SENDING_STALE_AFTER_MS)';
  end if;

  -- Reconciler roda (outra invocação, ou o cron de segurança) com a janela
  -- de staleness já vencida — simulado forçando sending_at pro passado.
  update dental_leads.messages set sending_at = now() - interval '1 hour' where id = v_msg;
  if dental_leads.reconcile_stuck_sending_bubbles(45000) < 1 then
    raise exception 'PONTO3a: bolha SENDING órfã e além do SENDING_STALE_AFTER_MS deveria ser reconciliada';
  end if;
  if (select send_status from dental_leads.messages where id = v_msg) <> 'UNKNOWN' then
    raise exception 'PONTO3b: bolha deveria estar UNKNOWN depois da reconciliação';
  end if;
  if not (select needs_human from dental_leads.leads where id = v_lead) then
    raise exception 'PONTO3c: reconciliação deveria marcar needs_human';
  end if;

  -- AGORA o POST original (que Worker A nunca soube que tinha sido
  -- reconciliado) retorna 2xx e o worker tenta finalizar como SENT.
  v_result := dental_leads.finalize_bubble_send(v_msg, v_job, 'worker-A', v_turn, 'SENT', 'EVO-TARDIO-1');

  if (v_result->>'finalized')::boolean then
    raise exception 'PONTO3d: Worker A NUNCA pode sobrescrever um estado que já foi reconciliado — update irrestrito é exatamente o bug que isto corrige';
  end if;
  if not (v_result->>'late')::boolean then
    raise exception 'PONTO3e: deveria ser reportado como resultado tardio (late=true)';
  end if;

  -- O estado continua UNKNOWN — não foi revertido silenciosamente.
  if (select send_status from dental_leads.messages where id = v_msg) <> 'UNKNOWN' then
    raise exception 'PONTO3f: send_status precisa continuar UNKNOWN, a confirmação tardia não pode reverter isso';
  end if;
  -- precisa continuar needs_human — ninguém "desfez" a necessidade de revisão humana
  if not (select needs_human from dental_leads.leads where id = v_lead) then
    raise exception 'PONTO3g: needs_human não pode ser revertido por uma confirmação tardia';
  end if;

  -- Mas a confirmação de entrega não se perde: fica registrada para
  -- auditoria (quem for revisar manualmente vê que, apesar do UNKNOWN, a
  -- Evolution efetivamente confirmou depois).
  if (select meta->'late_confirmation' from dental_leads.messages where id = v_msg) is null then
    raise exception 'PONTO3h: a confirmação tardia deveria ficar registrada em meta.late_confirmation, sem sobrescrever o estado';
  end if;
  if (select meta->'late_confirmation'->>'provider_message_id' from dental_leads.messages where id = v_msg) <> 'EVO-TARDIO-1' then
    raise exception 'PONTO3i: meta.late_confirmation deveria guardar o provider_message_id de verdade';
  end if;

  update dental_leads.jobs set status = 'FAILED', locked_by = null, lease_expires_at = null where id = v_job;
  update dental_leads.leads set needs_human = false, automation_status = 'ACTIVE' where id = v_lead;

  raise notice 'PONTO 3 OK: escrita final de send_status é guardada por estado+propriedade+turn_id, POST tardio não sobrescreve reconciliação';

  -- Confere também o caminho feliz de finalize_bubble_send (sem corrida):
  -- SENDING → SENT normal continua funcionando.
  insert into dental_leads.jobs (lead_id, status, debounce_started_at, run_after) values (v_lead, 'PENDING', now(), now());
  update dental_leads.jobs set run_after = now() where lead_id = v_lead and status = 'PENDING';
  select job_id, turn_id into v_job, v_turn from dental_leads.claim_lead_jobs('worker-A', 5, 120);

  v_result := dental_leads.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => (select conversation_revision from dental_leads.leads where id = v_lead),
    p_batch_ids => (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'caminho feliz', p_content_hash => 'hash-feliz', p_dedupe_seconds => 120);
  v_msg2 := (v_result->>'message_id')::uuid;
  perform dental_leads.advance_bubble_to_sending(v_msg2, v_job, 'worker-A', v_turn, v_lead,
    (select conversation_revision from dental_leads.leads where id = v_lead), (select coalesce(array_agg(id), array[]::uuid[]) from dental_leads.messages where lead_id = v_lead and direction = 'IN' and consumed_at is null), 'AI_REPLY');

  v_result := dental_leads.finalize_bubble_send(v_msg2, v_job, 'worker-A', v_turn, 'SENT', 'EVO-FELIZ-1');
  if not (v_result->>'finalized')::boolean then
    raise exception 'PONTO3j: caminho feliz (sem corrida) deveria finalizar normalmente (%)', v_result;
  end if;
  if (select send_status from dental_leads.messages where id = v_msg2) <> 'SENT' then
    raise exception 'PONTO3k: bolha deveria estar SENT';
  end if;

  update dental_leads.jobs set status = 'DONE' where lead_id = v_lead and status = 'RUNNING';

  raise notice 'TODOS OS CASOS PASSARAM';
end $$;

rollback;
