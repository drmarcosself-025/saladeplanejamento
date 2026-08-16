-- ============================================================================
-- Testes do motor de turno que dependem de Postgres de verdade.
--
-- Debounce, lock por lead, lease e stale são comportamentos de concorrência:
-- não se testam com mock. Rode contra um projeto Supabase de TESTE (nunca o
-- de produção) — o script termina em ROLLBACK e não deixa resíduo.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/turn_engine_test.sql
--
-- Sucesso = "TODOS OS CASOS PASSARAM" no final. Qualquer falha aborta com a
-- mensagem do caso que quebrou.
-- ============================================================================

begin;

do $$
declare
  v_lead    uuid;
  v_lead2   uuid;
  v_job     bigint;
  v_job2    bigint;
  v_result  jsonb;
  v_msg1    uuid;
  v_msg2    uuid;
  v_msg3    uuid;
  v_run1    timestamptz;
  v_run2    timestamptz;
  v_started timestamptz;
  v_count   int;
  v_ok      boolean;
begin
  -- ---------------------------------------------------------------------
  -- 1. Primeira mensagem cria lead, mensagem e UM job pendente
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'hash-1', null, null, false, null, 5, 30);

  v_lead := (v_result->>'lead_id')::uuid;
  v_msg1 := (v_result->>'message_id')::uuid;

  if (v_result->>'duplicate')::boolean then
    raise exception 'CASO 1: primeira mensagem não deveria ser duplicata';
  end if;
  if not (v_result->>'enqueued')::boolean then
    raise exception 'CASO 1: primeira mensagem deveria enfileirar um turno';
  end if;

  select id, run_after, debounce_started_at into v_job, v_run1, v_started
    from public.jobs where lead_id = v_lead and status = 'PENDING';

  if v_run1 < now() + interval '4 seconds' then
    raise exception 'CASO 1: run_after deveria estar ~5s no futuro (debounce)';
  end if;

  -- ---------------------------------------------------------------------
  -- 2. Segunda mensagem da rajada: mesmo job, janela empurrada,
  --    debounce_started_at PRESERVADO
  -- ---------------------------------------------------------------------
  perform pg_sleep(1);
  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-2', 'TEXT', 'Queria saber de Invisalign', '{}'::jsonb, now(), 'hash-2', null, null, false, null, 5, 30);
  v_msg2 := (v_result->>'message_id')::uuid;

  select count(*) into v_count from public.jobs where lead_id = v_lead and status = 'PENDING';
  if v_count <> 1 then
    raise exception 'CASO 2: a rajada deveria manter UM único job pendente, encontrei %', v_count;
  end if;

  select run_after into v_run2 from public.jobs where id = v_job;
  if v_run2 <= v_run1 then
    raise exception 'CASO 2: mensagem nova deveria empurrar a janela de debounce';
  end if;

  if (select debounce_started_at from public.jobs where id = v_job) <> v_started then
    raise exception 'CASO 2: debounce_started_at pertence à rajada e NUNCA pode ser reescrito';
  end if;

  -- ---------------------------------------------------------------------
  -- 3. Teto de espera: quem digita sem parar ainda é respondido
  -- ---------------------------------------------------------------------
  update public.jobs set debounce_started_at = now() - interval '29 seconds' where id = v_job;

  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-3', 'TEXT', 'Quanto fica?', '{}'::jsonb, now(), 'hash-3', null, null, false, null, 5, 30);
  v_msg3 := (v_result->>'message_id')::uuid;

  select run_after into v_run2 from public.jobs where id = v_job;
  if v_run2 > now() + interval '2 seconds' then
    raise exception 'CASO 3: o teto de 30s desde o início da rajada não foi respeitado (run_after=%)', v_run2;
  end if;

  -- ---------------------------------------------------------------------
  -- 4. Reentrega da Evolution não duplica nem reinicia a janela
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'hash-1', null, null, false, null, 5, 30);

  if not (v_result->>'duplicate')::boolean then
    raise exception 'CASO 4: provider_message_id repetido deveria ser duplicata';
  end if;

  select count(*) into v_count from public.messages where lead_id = v_lead and direction = 'IN';
  if v_count <> 3 then
    raise exception 'CASO 4: deveriam existir 3 mensagens, encontrei %', v_count;
  end if;

  -- ---------------------------------------------------------------------
  -- 5. Claim: respeita run_after e o lock por lead
  -- ---------------------------------------------------------------------
  update public.jobs set run_after = now() + interval '10 seconds' where id = v_job;
  if exists (select 1 from public.claim_lead_jobs('worker-A', 5, 120)) then
    raise exception 'CASO 5: turno com janela de debounce aberta não pode ser claimado';
  end if;

  update public.jobs set run_after = now() where id = v_job;
  select count(*) into v_count from public.claim_lead_jobs('worker-A', 5, 120);
  if v_count <> 1 then
    raise exception 'CASO 5: turno maduro deveria ser claimado uma vez, obtive %', v_count;
  end if;

  if exists (select 1 from public.claim_lead_jobs('worker-B', 5, 120)) then
    raise exception 'CASO 5: lead já em processamento não pode ser claimado por outro worker';
  end if;

  -- ---------------------------------------------------------------------
  -- 6. Batch: todas as mensagens elegíveis, em ordem cronológica
  -- ---------------------------------------------------------------------
  select count(*) into v_count from public.fetch_batch(v_lead);
  if v_count <> 3 then
    raise exception 'CASO 6: o batch deveria conter as 3 mensagens da rajada, contei %', v_count;
  end if;

  if (select array_agg(id order by received_at, id) from public.fetch_batch(v_lead))
     <> array[v_msg1, v_msg2, v_msg3] then
    raise exception 'CASO 6: o batch saiu fora da ordem cronológica';
  end if;

  -- ---------------------------------------------------------------------
  -- 7. assert_turn_valid — o portão de todo envio
  -- ---------------------------------------------------------------------
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 'AI_REPLY');
  if not (v_result->>'valid')::boolean then
    raise exception 'CASO 7a: turno íntegro deveria ser válido (%)', v_result->>'reason';
  end if;

  v_result := public.assert_turn_valid(v_job, 'worker-B', v_lead, array[v_msg1, v_msg2, v_msg3], 'AI_REPLY');
  if (v_result->>'reason') <> 'lease_perdido' then
    raise exception 'CASO 7b: worker sem posse do lease deveria ser barrado, veio %', v_result->>'reason';
  end if;

  -- batch incompleto = existe mensagem nova fora dele = resposta obsoleta
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2], 'AI_REPLY');
  if (v_result->>'reason') <> 'stale_nova_mensagem' then
    raise exception 'CASO 7c: mensagem fora do batch deveria invalidar o turno, veio %', v_result->>'reason';
  end if;

  update public.leads set automation_status = 'HUMAN_TAKEOVER' where id = v_lead;
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 'AI_REPLY');
  if (v_result->>'reason') <> 'human_takeover' then
    raise exception 'CASO 7d: takeover humano deveria interromper o turno, veio %', v_result->>'reason';
  end if;

  update public.leads set automation_status = 'HUMAN_REQUIRED', needs_human = true where id = v_lead;
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 'AI_REPLY');
  if (v_result->>'valid')::boolean then
    raise exception 'CASO 7e: resposta da IA não pode sair com lead aguardando humano';
  end if;

  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 'HANDOFF');
  if not (v_result->>'valid')::boolean then
    raise exception 'CASO 7f: a frase neutra PODE sair em HUMAN_REQUIRED (%)', v_result->>'reason';
  end if;

  update public.leads set automation_status = 'ACTIVE', needs_human = false where id = v_lead;

  -- ---------------------------------------------------------------------
  -- 8. close_turn sem envio devolve o batch para o próximo turno
  -- ---------------------------------------------------------------------
  perform public.close_turn(v_job, 'worker-A', 'STALE_BEFORE_SEND', array[v_msg1, v_msg2, v_msg3], false, null, 4, 120);

  select count(*) into v_count from public.messages
   where id = any (array[v_msg1, v_msg2, v_msg3]) and processed;
  if v_count <> 0 then
    raise exception 'CASO 8: turno abortado antes do envio NÃO pode marcar o batch como processado';
  end if;

  if (select status from public.jobs where id = v_job) <> 'DONE' then
    raise exception 'CASO 8: o job deveria estar encerrado';
  end if;

  -- ---------------------------------------------------------------------
  -- 9. close_turn com envio marca o batch como processado
  -- ---------------------------------------------------------------------
  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  perform public.claim_lead_jobs('worker-A', 5, 120);

  perform public.close_turn(v_job, 'worker-A', 'COMPLETED', array[v_msg1, v_msg2, v_msg3], true, null, 4, 120);

  select count(*) into v_count from public.messages
   where id = any (array[v_msg1, v_msg2, v_msg3]) and processed;
  if v_count <> 3 then
    raise exception 'CASO 9: turno concluído deveria marcar as 3 mensagens como processadas, marcou %', v_count;
  end if;

  if exists (select 1 from public.fetch_batch(v_lead)) then
    raise exception 'CASO 9: o batch deveria estar vazio depois do turno concluído';
  end if;

  -- ---------------------------------------------------------------------
  -- 10. FAILED: retry com backoff e, no limite, caso humano
  -- ---------------------------------------------------------------------
  insert into public.jobs (lead_id, status, debounce_started_at, run_after, attempts)
  values (v_lead, 'PENDING', now(), now(), 1) returning id into v_job;
  perform public.claim_lead_jobs('worker-A', 5, 120);

  perform public.close_turn(v_job, 'worker-A', 'FAILED', array[]::uuid[], false, 'erro de rede', 4, 120);
  if (select status from public.jobs where id = v_job) <> 'PENDING' then
    raise exception 'CASO 10a: falha transitória deveria voltar para a fila';
  end if;
  if (select next_attempt_at from public.jobs where id = v_job) <= now() then
    raise exception 'CASO 10a: o retry deveria respeitar backoff';
  end if;

  update public.jobs set attempts = 4, status = 'RUNNING', locked_by = 'worker-A',
         lease_expires_at = now() + interval '120 seconds'
   where id = v_job;
  perform public.close_turn(v_job, 'worker-A', 'FAILED', array[]::uuid[], false, 'erro persistente', 4, 120);

  if (select status from public.jobs where id = v_job) <> 'FAILED' then
    raise exception 'CASO 10b: tentativas esgotadas deveriam encerrar o job como FAILED';
  end if;
  if not (select needs_human from public.leads where id = v_lead) then
    raise exception 'CASO 10b: nenhum lead pode morrer em silêncio dentro da fila';
  end if;

  update public.leads set needs_human = false, automation_status = 'ACTIVE' where id = v_lead;

  -- ---------------------------------------------------------------------
  -- 11. Lease expirado volta para a fila (worker morto)
  -- ---------------------------------------------------------------------
  insert into public.jobs (lead_id, status, debounce_started_at, run_after,
                           locked_by, lease_expires_at)
  values (v_lead, 'RUNNING', now(), now(), 'worker-morto', now() - interval '1 second')
  returning id into v_job;

  if public.reclaim_expired_jobs() <> 1 then
    raise exception 'CASO 11: o turno com lease vencido deveria voltar para a fila';
  end if;
  if (select status from public.jobs where id = v_job) <> 'PENDING' then
    raise exception 'CASO 11: status deveria ser PENDING após o reclaim';
  end if;

  -- Renovação do lease: só o dono renova.
  perform public.claim_lead_jobs('worker-A', 5, 120);
  if not public.renew_lease(v_job, 'worker-A', 120) then
    raise exception 'CASO 11: o dono do lease deveria conseguir renovar';
  end if;
  if public.renew_lease(v_job, 'worker-B', 120) then
    raise exception 'CASO 11: quem não é dono do lease NÃO pode renovar';
  end if;
  perform public.close_turn(v_job, 'worker-A', 'NO_REPLY', array[]::uuid[], false, null, 4, 120);

  -- ---------------------------------------------------------------------
  -- 12. Leads diferentes seguem em paralelo
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990002@s.whatsapp.net', '5511999990002', false, 'João',
    'MSG-B1', 'TEXT', 'Oi, queria informação', '{}'::jsonb, now(), 'hash-b1', null, null, false, null, 5, 30);
  v_lead2 := (v_result->>'lead_id')::uuid;

  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-4', 'TEXT', 'Voltei', '{}'::jsonb, now(), 'hash-4', null, null, false, null, 5, 30);

  update public.jobs set run_after = now() where status = 'PENDING';
  select count(*) into v_count from public.claim_lead_jobs('worker-C', 5, 120);
  if v_count <> 2 then
    raise exception 'CASO 12: dois leads distintos deveriam ser claimados juntos, obtive %', v_count;
  end if;

  -- ---------------------------------------------------------------------
  -- 13. Takeover cancela o turno pendente
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990003@s.whatsapp.net', '5511999990003', false, 'Ana',
    'MSG-C1', 'TEXT', 'Bom dia', '{}'::jsonb, now(), 'hash-c1', null, null, false, null, 5, 30);

  v_result := public.ingest_outbound_event(
    '5511999990003@s.whatsapp.net', '5511999990003', false, 'Ana',
    'MSG-HUMANO', 'TEXT', 'Oi Ana, aqui é a Carla da clínica', '{}'::jsonb, now(), 120, 'hash-humano');

  if not (v_result->>'takeover')::boolean then
    raise exception 'CASO 13: mensagem manual pelo WhatsApp deveria ligar o human takeover';
  end if;
  if exists (
    select 1 from public.jobs j
      join public.leads l on l.id = j.lead_id
     where l.whatsapp_id = '5511999990003@s.whatsapp.net' and j.status = 'PENDING'
  ) then
    raise exception 'CASO 13: o turno pendente deveria ser cancelado pelo takeover';
  end if;

  -- Eco da nossa própria bolha NÃO é takeover.
  insert into public.messages (lead_id, direction, sender_type, message_type, text,
                               processed, content_hash, send_status)
  values (v_lead2, 'OUT', 'AI', 'TEXT', 'Claro 😊', true, 'hash-eco', 'PENDING');

  v_result := public.ingest_outbound_event(
    '5511999990002@s.whatsapp.net', '5511999990002', false, 'João',
    'MSG-ECO', 'TEXT', 'Claro 😊', '{}'::jsonb, now(), 120, 'hash-eco');

  if (v_result->>'takeover')::boolean then
    raise exception 'CASO 13: o eco da nossa própria mensagem não pode virar takeover';
  end if;
  if (select send_status from public.messages where provider_message_id = 'MSG-ECO') <> 'SENT' then
    raise exception 'CASO 13: o eco deveria carimbar a bolha como SENT';
  end if;

  raise notice 'TODOS OS CASOS PASSARAM';
end $$;

rollback;
