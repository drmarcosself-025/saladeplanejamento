-- ============================================================================
-- Testes do motor de turno que dependem de Postgres de verdade.
--
-- Debounce, lock por lead, lease, revisão da conversa e fencing são
-- comportamentos de concorrência: não se testam com mock. Rode contra um
-- projeto Supabase de TESTE (nunca o de produção) — o script termina em
-- ROLLBACK e não deixa resíduo.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/turn_engine_test.sql
--
-- Requer as migrations 0001, 0003 e 0004 já aplicadas.
-- Sucesso = "TODOS OS CASOS PASSARAM" no final.
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
  v_rev     bigint;
  v_turn    uuid;
begin
  -- ---------------------------------------------------------------------
  -- 1. Primeira mensagem cria lead, mensagem, incrementa a revisão e cria
  --    UM job pendente
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
  if (v_result->>'revision')::bigint <> 1 then
    raise exception 'CASO 1: primeira mensagem genuína deveria levar a revisão a 1, veio %', v_result->>'revision';
  end if;
  if (select conversation_revision from public.leads where id = v_lead) <> 1 then
    raise exception 'CASO 1: leads.conversation_revision deveria ser 1';
  end if;

  select id, run_after, debounce_started_at into v_job, v_run1, v_started
    from public.jobs where lead_id = v_lead and status = 'PENDING';

  if v_run1 < now() + interval '4 seconds' then
    raise exception 'CASO 1: run_after deveria estar ~5s no futuro (debounce)';
  end if;

  -- ---------------------------------------------------------------------
  -- 2. Segunda mensagem da rajada: mesmo job, janela empurrada,
  --    debounce_started_at PRESERVADO, revisão sobe para 2
  -- ---------------------------------------------------------------------
  perform pg_sleep(1);
  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-2', 'TEXT', 'Queria saber de Invisalign', '{}'::jsonb, now(), 'hash-2', null, null, false, null, 5, 30);
  v_msg2 := (v_result->>'message_id')::uuid;

  if (v_result->>'revision')::bigint <> 2 then
    raise exception 'CASO 2: segunda mensagem genuína deveria levar a revisão a 2, veio %', v_result->>'revision';
  end if;

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
  -- 4. Reentrega da Evolution não duplica, não reinicia a janela e NÃO
  --    incrementa a revisão (não é mensagem genuína nova)
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'hash-1', null, null, false, null, 5, 30);

  if not (v_result->>'duplicate')::boolean then
    raise exception 'CASO 4: provider_message_id repetido deveria ser duplicata';
  end if;

  select conversation_revision into v_rev from public.leads where id = v_lead;
  if v_rev <> 3 then
    raise exception 'CASO 4: reentrega não pode incrementar a revisão (esperado 3, veio %)', v_rev;
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

  select turn_id into v_turn from public.jobs where id = v_job;

  if exists (select 1 from public.claim_lead_jobs('worker-B', 5, 120)) then
    raise exception 'CASO 5: lead já em processamento não pode ser claimado por outro worker';
  end if;

  -- ---------------------------------------------------------------------
  -- 6. Batch: todas as mensagens elegíveis, em ordem cronológica, e a
  --    revisão devolvida bate com o estado atual do lead
  -- ---------------------------------------------------------------------
  select count(*) into v_count from public.fetch_batch(v_lead);
  if v_count <> 3 then
    raise exception 'CASO 6: o batch deveria conter as 3 mensagens da rajada, contei %', v_count;
  end if;

  if (select array_agg(id order by received_at, id) from public.fetch_batch(v_lead))
     <> array[v_msg1, v_msg2, v_msg3] then
    raise exception 'CASO 6: o batch saiu fora da ordem cronológica';
  end if;

  if (select distinct conversation_revision from public.fetch_batch(v_lead)) <> 3 then
    raise exception 'CASO 6: fetch_batch deveria devolver a revisão atual (3) junto com as mensagens';
  end if;

  -- ---------------------------------------------------------------------
  -- 7. assert_turn_valid — checkpoint de leitura, agora com revisão
  -- ---------------------------------------------------------------------
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 3, 'AI_REPLY');
  if not (v_result->>'valid')::boolean then
    raise exception 'CASO 7a: turno íntegro deveria ser válido (%)', v_result->>'reason';
  end if;

  v_result := public.assert_turn_valid(v_job, 'worker-B', v_lead, array[v_msg1, v_msg2, v_msg3], 3, 'AI_REPLY');
  if (v_result->>'reason') <> 'lease_perdido' then
    raise exception 'CASO 7b: worker sem posse do lease deveria ser barrado, veio %', v_result->>'reason';
  end if;

  -- revisão desatualizada = turno obsoleto, mesmo que o conjunto de ids
  -- pareça completo (é a checagem O(1) fazendo o trabalho sozinha)
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 2, 'AI_REPLY');
  if (v_result->>'reason') <> 'stale_revision_mismatch' then
    raise exception 'CASO 7c: revisão desatualizada deveria invalidar o turno, veio %', v_result->>'reason';
  end if;

  -- defesa em profundidade: revisão bate, mas falta mensagem no conjunto
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2], 3, 'AI_REPLY');
  if (v_result->>'reason') <> 'stale_nova_mensagem' then
    raise exception 'CASO 7d: conjunto incompleto deveria invalidar o turno, veio %', v_result->>'reason';
  end if;

  update public.leads set automation_status = 'HUMAN_TAKEOVER' where id = v_lead;
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 3, 'AI_REPLY');
  if (v_result->>'reason') <> 'human_takeover' then
    raise exception 'CASO 7e: takeover humano deveria interromper o turno, veio %', v_result->>'reason';
  end if;

  update public.leads set automation_status = 'HUMAN_REQUIRED', needs_human = true where id = v_lead;
  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 3, 'AI_REPLY');
  if (v_result->>'valid')::boolean then
    raise exception 'CASO 7f: resposta da IA não pode sair com lead aguardando humano';
  end if;

  v_result := public.assert_turn_valid(v_job, 'worker-A', v_lead, array[v_msg1, v_msg2, v_msg3], 3, 'HANDOFF');
  if not (v_result->>'valid')::boolean then
    raise exception 'CASO 7g: a frase neutra PODE sair em HUMAN_REQUIRED (%)', v_result->>'reason';
  end if;

  update public.leads set automation_status = 'ACTIVE', needs_human = false where id = v_lead;

  -- ---------------------------------------------------------------------
  -- 8. reserve_outbound_bubble — o portão atômico
  -- ---------------------------------------------------------------------

  -- 8a. worker sem posse do lease não consegue reservar (nem checar-depois-
  --     gravar: a função inteira recusa numa única chamada)
  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-intruso', p_lead_id => v_lead,
    p_input_revision => 3, p_batch_ids => array[v_msg1, v_msg2, v_msg3],
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Claro 😊', p_content_hash => 'hash-bolha-1', p_dedupe_seconds => 120);
  if (v_result->>'reserved')::boolean then
    raise exception 'CASO 8a: worker sem posse do lease NUNCA pode reservar uma bolha';
  end if;
  if (v_result->>'reason') <> 'lease_perdido' then
    raise exception 'CASO 8a: motivo esperado lease_perdido, veio %', v_result->>'reason';
  end if;

  -- 8b. revisão desatualizada bloqueia a reserva mesmo com lease correto
  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => 2, p_batch_ids => array[v_msg1, v_msg2, v_msg3],
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Claro 😊', p_content_hash => 'hash-bolha-1', p_dedupe_seconds => 120);
  if (v_result->>'reserved')::boolean then
    raise exception 'CASO 8b: revisão velha nunca pode reservar uma bolha';
  end if;
  if (v_result->>'reason') <> 'stale_revision_mismatch' then
    raise exception 'CASO 8b: motivo esperado stale_revision_mismatch, veio %', v_result->>'reason';
  end if;

  -- 8c. dono do lease, revisão correta, batch completo: reserva de verdade
  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => 3, p_batch_ids => array[v_msg1, v_msg2, v_msg3],
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Claro 😊', p_content_hash => 'hash-bolha-1', p_dedupe_seconds => 120);
  if not (v_result->>'reserved')::boolean then
    raise exception 'CASO 8c: dono do lease com revisão e batch corretos deveria reservar (%)', v_result->>'reason';
  end if;

  -- 8d. a mesma bolha (mesmo hash) não é reservada de novo dentro da janela
  --     de dedupe — protege contra worker zumbi reenviando
  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => 3, p_batch_ids => array[v_msg1, v_msg2, v_msg3],
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Claro 😊', p_content_hash => 'hash-bolha-1', p_dedupe_seconds => 120);
  if (v_result->>'reserved')::boolean then
    raise exception 'CASO 8d: bolha idêntica recente deveria ser recusada como duplicata';
  end if;
  if (v_result->>'reason') <> 'duplicado' then
    raise exception 'CASO 8d: motivo esperado duplicado, veio %', v_result->>'reason';
  end if;

  -- 8e. batch incompleto (defesa em profundidade): revisão bate, mas falta
  --     uma mensagem no conjunto informado
  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A', p_lead_id => v_lead,
    p_input_revision => 3, p_batch_ids => array[v_msg1, v_msg2],
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 2,
    p_text => 'Outra bolha diferente', p_content_hash => 'hash-bolha-2', p_dedupe_seconds => 120);
  if (v_result->>'reserved')::boolean then
    raise exception 'CASO 8e: conjunto incompleto deveria recusar a reserva mesmo com revisão correta';
  end if;
  if (v_result->>'reason') <> 'stale_nova_mensagem' then
    raise exception 'CASO 8e: motivo esperado stale_nova_mensagem, veio %', v_result->>'reason';
  end if;

  -- ---------------------------------------------------------------------
  -- 9. RUNNING expirado + PENDING mais novo: cenário do item 2 da revisão.
  --
  --    Job A = RUNNING, chega mensagem nova -> Job B = PENDING,
  --    lease de A expira. A não pode voltar a PENDING (já existe B).
  --    A é encerrado como FAILED/lease-expirado; B assume o próximo turno;
  --    o worker antigo de A fica impedido pelo fencing (reserve_outbound_
  --    bubble recusa porque locked_by já não é mais dele).
  -- ---------------------------------------------------------------------
  -- fecha o job 5-8 corretamente antes de montar o cenário 9
  perform public.close_turn(v_job, 'worker-A', 'COMPLETED', array[v_msg1, v_msg2, v_msg3], true, null, 4, 120);

  -- Job A: simula um turno RUNNING com lease já vencido
  insert into public.jobs (lead_id, status, debounce_started_at, run_after,
                           locked_by, lease_expires_at, turn_id, attempts)
  values (v_lead, 'RUNNING', now() - interval '200 seconds', now() - interval '200 seconds',
          'worker-A-antigo', now() - interval '80 seconds', gen_random_uuid(), 1)
  returning id, turn_id into v_job, v_turn;

  -- Chega mensagem nova: cria o Job B = PENDING para o mesmo lead
  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-4', 'TEXT', 'Ainda aí?', '{}'::jsonb, now(), 'hash-4', null, null, false, null, 5, 30);
  v_rev := (v_result->>'revision')::bigint;

  select id into v_job2 from public.jobs where lead_id = v_lead and status = 'PENDING';
  if v_job2 is null then
    raise exception 'CASO 9a: deveria existir um job PENDING novo (Job B) para o lead';
  end if;

  -- reclaim: A não pode voltar para PENDING (B já existe) — A é encerrado
  perform public.reclaim_expired_jobs();

  if (select status from public.jobs where id = v_job) <> 'FAILED' then
    raise exception 'CASO 9b: Job A (lease vencido, B já pendente) deveria ser encerrado como FAILED, não reaberto';
  end if;

  if (select status from public.jobs where id = v_job2) <> 'PENDING' then
    raise exception 'CASO 9c: Job B deveria continuar PENDING, intacto';
  end if;

  select count(*) into v_count from public.jobs where lead_id = v_lead and status = 'PENDING';
  if v_count <> 1 then
    raise exception 'CASO 9d: nunca pode existir mais de um PENDING por lead, encontrei %', v_count;
  end if;

  -- Fencing: o worker antigo de A tenta continuar agindo — precisa ser
  -- impedido de gravar qualquer coisa, mesmo sabendo o job_id certo e a
  -- revisão atual (v_rev). O que barra é a posse do lease (locked_by/status),
  -- não a revisão.
  v_result := public.reserve_outbound_bubble(
    p_job_id => v_job, p_worker_id => 'worker-A-antigo', p_lead_id => v_lead,
    p_input_revision => v_rev, p_batch_ids => array[]::uuid[],
    p_purpose => 'AI_REPLY', p_turn_id => v_turn, p_sequence => 1,
    p_text => 'Oi, ainda estou aqui!', p_content_hash => 'hash-zumbi', p_dedupe_seconds => 120);
  if (v_result->>'reserved')::boolean then
    raise exception 'CASO 9e: worker antigo de um job já FAILED NUNCA pode gravar uma bolha';
  end if;
  if (v_result->>'reason') <> 'lease_perdido' then
    raise exception 'CASO 9e: motivo esperado lease_perdido (job não é mais RUNNING/seu), veio %', v_result->>'reason';
  end if;

  -- B assume o próximo turno normalmente
  update public.jobs set run_after = now() where id = v_job2;
  select count(*) into v_count from public.claim_lead_jobs('worker-C', 5, 120);
  if v_count <> 1 then
    raise exception 'CASO 9f: Job B deveria ser claimável normalmente após A ser encerrado';
  end if;

  select turn_id into v_turn from public.jobs where id = v_job2;
  perform public.close_turn(v_job2, 'worker-C', 'NO_REPLY', array[]::uuid[], false, null, 4, 120);

  -- ---------------------------------------------------------------------
  -- 10. close_turn sem envio devolve o batch para o próximo turno
  --     (consumed_at/consumed_by_turn_id, não mais o boolean processed)
  --
  -- Cenário isolado: uma mensagem nova, própria para este caso, para não
  -- depender do estado exato deixado pelos casos anteriores.
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-10', 'TEXT', 'Ainda quero saber do preço', '{}'::jsonb, now(), 'hash-10', null, null, false, null, 5, 30);
  v_msg1 := (v_result->>'message_id')::uuid;

  select id into v_job from public.jobs where lead_id = v_lead and status = 'PENDING';
  update public.jobs set run_after = now() where id = v_job;
  perform public.claim_lead_jobs('worker-A', 5, 120);

  perform public.close_turn(v_job, 'worker-A', 'STALE_BEFORE_SEND', array[v_msg1], false, null, 4, 120);
  if (select consumed_at from public.messages where id = v_msg1) is not null then
    raise exception 'CASO 10: turno abortado antes do envio NÃO pode marcar a mensagem como consumida';
  end if;
  if not exists (select 1 from public.fetch_batch(v_lead) where id = v_msg1) then
    raise exception 'CASO 10: mensagem não consumida deveria continuar aparecendo no batch';
  end if;

  -- ---------------------------------------------------------------------
  -- 11. close_turn com envio marca consumed_at/consumed_by_turn_id = turn_id
  -- ---------------------------------------------------------------------
  -- o job anterior fechou como DONE; um novo turno reprocessa a mesma
  -- mensagem, ainda não consumida
  insert into public.jobs (lead_id, status, debounce_started_at, run_after)
  values (v_lead, 'PENDING', now(), now()) returning id into v_job;
  perform public.claim_lead_jobs('worker-A', 5, 120);
  select turn_id into v_turn from public.jobs where id = v_job;

  perform public.close_turn(v_job, 'worker-A', 'COMPLETED', array[v_msg1], true, null, 4, 120);
  if (select consumed_at from public.messages where id = v_msg1) is null then
    raise exception 'CASO 11a: turno concluído deveria marcar consumed_at';
  end if;
  if (select consumed_by_turn_id from public.messages where id = v_msg1) <> v_turn then
    raise exception 'CASO 11b: consumed_by_turn_id deveria apontar para o turno que consumiu a mensagem';
  end if;
  if exists (select 1 from public.fetch_batch(v_lead) where id = v_msg1) then
    raise exception 'CASO 11c: mensagem consumida não pode reaparecer em nenhum batch futuro';
  end if;

  -- ---------------------------------------------------------------------
  -- 12. FAILED: retry com backoff e, no limite, caso humano
  -- ---------------------------------------------------------------------
  insert into public.jobs (lead_id, status, debounce_started_at, run_after, attempts)
  values (v_lead, 'PENDING', now(), now(), 1) returning id into v_job;
  perform public.claim_lead_jobs('worker-A', 5, 120);

  perform public.close_turn(v_job, 'worker-A', 'FAILED', array[]::uuid[], false, 'erro de rede', 4, 120);
  if (select status from public.jobs where id = v_job) <> 'PENDING' then
    raise exception 'CASO 12a: falha transitória deveria voltar para a fila';
  end if;
  if (select next_attempt_at from public.jobs where id = v_job) <= now() then
    raise exception 'CASO 12a: o retry deveria respeitar backoff';
  end if;

  update public.jobs set attempts = 4, status = 'RUNNING', locked_by = 'worker-A',
         lease_expires_at = now() + interval '120 seconds'
   where id = v_job;
  perform public.close_turn(v_job, 'worker-A', 'FAILED', array[]::uuid[], false, 'erro persistente', 4, 120);

  if (select status from public.jobs where id = v_job) <> 'FAILED' then
    raise exception 'CASO 12b: tentativas esgotadas deveriam encerrar o job como FAILED';
  end if;
  if not (select needs_human from public.leads where id = v_lead) then
    raise exception 'CASO 12b: nenhum lead pode morrer em silêncio dentro da fila';
  end if;

  update public.leads set needs_human = false, automation_status = 'ACTIVE' where id = v_lead;

  -- ---------------------------------------------------------------------
  -- 13. Lease expirado (sem PENDING concorrente) volta para PENDING;
  --     renovação só pelo dono
  -- ---------------------------------------------------------------------
  insert into public.jobs (lead_id, status, debounce_started_at, run_after,
                           locked_by, lease_expires_at)
  values (v_lead, 'RUNNING', now(), now(), 'worker-morto', now() - interval '1 second')
  returning id into v_job;

  if public.reclaim_expired_jobs() <> 1 then
    raise exception 'CASO 13a: o turno com lease vencido (sem concorrente) deveria voltar para a fila';
  end if;
  if (select status from public.jobs where id = v_job) <> 'PENDING' then
    raise exception 'CASO 13a: status deveria ser PENDING após o reclaim';
  end if;

  perform public.claim_lead_jobs('worker-A', 5, 120);
  if not public.renew_lease(v_job, 'worker-A', 120) then
    raise exception 'CASO 13b: o dono do lease deveria conseguir renovar';
  end if;
  if public.renew_lease(v_job, 'worker-B', 120) then
    raise exception 'CASO 13b: quem não é dono do lease NÃO pode renovar';
  end if;
  perform public.close_turn(v_job, 'worker-A', 'NO_REPLY', array[]::uuid[], false, null, 4, 120);

  -- ---------------------------------------------------------------------
  -- 14. Leads diferentes seguem em paralelo
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990002@s.whatsapp.net', '5511999990002', false, 'João',
    'MSG-B1', 'TEXT', 'Oi, queria informação', '{}'::jsonb, now(), 'hash-b1', null, null, false, null, 5, 30);
  v_lead2 := (v_result->>'lead_id')::uuid;

  v_result := public.ingest_inbound_message(
    '5511999990001@s.whatsapp.net', '5511999990001', false, 'Maria',
    'MSG-5', 'TEXT', 'Voltei', '{}'::jsonb, now(), 'hash-5', null, null, false, null, 5, 30);

  update public.jobs set run_after = now() where status = 'PENDING';
  select count(*) into v_count from public.claim_lead_jobs('worker-D', 5, 120);
  if v_count <> 2 then
    raise exception 'CASO 14: dois leads distintos deveriam ser claimados juntos, obtive %', v_count;
  end if;

  -- ---------------------------------------------------------------------
  -- 15. Takeover cancela o turno pendente; eco da própria bolha não é
  --     takeover
  -- ---------------------------------------------------------------------
  v_result := public.ingest_inbound_message(
    '5511999990003@s.whatsapp.net', '5511999990003', false, 'Ana',
    'MSG-C1', 'TEXT', 'Bom dia', '{}'::jsonb, now(), 'hash-c1', null, null, false, null, 5, 30);

  v_result := public.ingest_outbound_event(
    '5511999990003@s.whatsapp.net', '5511999990003', false, 'Ana',
    'MSG-HUMANO', 'TEXT', 'Oi Ana, aqui é a Carla da clínica', '{}'::jsonb, now(), 120, 'hash-humano');

  if not (v_result->>'takeover')::boolean then
    raise exception 'CASO 15a: mensagem manual pelo WhatsApp deveria ligar o human takeover';
  end if;
  if exists (
    select 1 from public.jobs j
      join public.leads l on l.id = j.lead_id
     where l.whatsapp_id = '5511999990003@s.whatsapp.net' and j.status = 'PENDING'
  ) then
    raise exception 'CASO 15a: o turno pendente deveria ser cancelado pelo takeover';
  end if;

  insert into public.messages (lead_id, direction, sender_type, message_type, text,
                               content_hash, send_status)
  values (v_lead2, 'OUT', 'AI', 'TEXT', 'Claro 😊', 'hash-eco', 'PENDING');

  v_result := public.ingest_outbound_event(
    '5511999990002@s.whatsapp.net', '5511999990002', false, 'João',
    'MSG-ECO', 'TEXT', 'Claro 😊', '{}'::jsonb, now(), 120, 'hash-eco');

  if (v_result->>'takeover')::boolean then
    raise exception 'CASO 15b: o eco da nossa própria mensagem não pode virar takeover';
  end if;
  if (select send_status from public.messages where provider_message_id = 'MSG-ECO') <> 'SENT' then
    raise exception 'CASO 15b: o eco deveria carimbar a bolha como SENT';
  end if;

  raise notice 'TODOS OS CASOS PASSARAM';
end $$;

rollback;
