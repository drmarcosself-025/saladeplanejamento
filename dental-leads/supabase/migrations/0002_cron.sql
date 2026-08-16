-- ============================================================================
-- Rede de segurança da fila (opcional, porém recomendada).
--
-- O caminho primário é o wa-webhook chamando o lead-worker, que espera a
-- janela de debounce e então pega o turno. Este cron existe só para o caso de
-- esse disparo falhar (rede, cold start, deploy no meio do caminho) — ele
-- varre turnos maduros e jobs em retry por backoff.
--
-- ANTES DE RODAR: substitua os dois placeholders abaixo.
--   <PROJECT_REF>   ref do projeto Supabase (ex.: abcdefghijklmnop)
--   <WORKER_SECRET> mesmo valor do secret WORKER_SECRET das Edge Functions
--
-- Rodar este arquivo com os placeholders sem substituir não quebra nada: o
-- cron simplesmente vai receber 401 do worker.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('lead-worker-sweep')
 where exists (select 1 from cron.job where jobname = 'lead-worker-sweep');

select cron.schedule(
  'lead-worker-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/lead-worker',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-worker-secret', '<WORKER_SECRET>'
               ),
    body    := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 55000
  )
  where exists (
    -- run_after respeita a janela de debounce: o cron nunca "atropela" um
    -- lead que ainda está escrevendo.
    select 1 from public.jobs
     where status = 'PENDING'
       and run_after <= now()
       and next_attempt_at <= now()
  );
  $$
);
