#!/usr/bin/env bash
# ============================================================================
# Teste de concorrência real do lock por lead.
#
# O teste transacional (turn_engine_test.sql) roda tudo em uma sessão só —
# ele prova a lógica, mas não prova exclusão mútua. Aqui vários processos
# psql disputam o mesmo turno ao mesmo tempo, que é o cenário que de fato
# duplicaria uma resposta para o lead.
#
# Uso (contra um banco de TESTE):
#   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... ./concurrency_test.sh
# ============================================================================
set -euo pipefail

WORKERS="${WORKERS:-8}"
PSQL="psql -X -q -A -t -v ON_ERROR_STOP=1"

echo "== preparando cenário"
$PSQL <<'SQL'
delete from public.jobs where lead_id in (
  select id from public.leads where whatsapp_id like '55119999900%@s.whatsapp.net'
);
delete from public.leads where whatsapp_id like '55119999900%@s.whatsapp.net';

select public.ingest_inbound_message(
  '5511999990010@s.whatsapp.net', '5511999990010', false, 'Concorrência A',
  'CONC-A1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'h-a1', null, null, false, null, 5, 30);

select public.ingest_inbound_message(
  '5511999990011@s.whatsapp.net', '5511999990011', false, 'Concorrência B',
  'CONC-B1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'h-b1', null, null, false, null, 5, 30);

-- Janela de debounce já vencida: os dois turnos estão maduros.
update public.jobs set run_after = now() where status = 'PENDING';
SQL

echo "== $WORKERS workers disputando 2 leads simultaneamente"
tmp=$(mktemp -d)
for i in $(seq 1 "$WORKERS"); do
  (
    $PSQL -c "select count(*) from public.claim_lead_jobs('worker-$i', 5, 120);" > "$tmp/w$i.out" 2>&1
  ) &
done
wait

total=0
for i in $(seq 1 "$WORKERS"); do
  claimed=$(tr -d '[:space:]' < "$tmp/w$i.out")
  [ -n "$claimed" ] || claimed=0
  total=$((total + claimed))
done
rm -rf "$tmp"

echo "turnos claimados no total: $total (esperado: 2 — um por lead, nunca dois no mesmo)"

$PSQL <<'SQL'
do $$
declare
  v_running int;
  v_por_lead int;
begin
  select count(*) into v_running
    from public.jobs j join public.leads l on l.id = j.lead_id
   where l.whatsapp_id like '55119999900%@s.whatsapp.net' and j.status = 'RUNNING';

  if v_running <> 2 then
    raise exception 'FALHOU: deveriam existir 2 turnos em execução (um por lead), há %', v_running;
  end if;

  select max(c) into v_por_lead from (
    select count(*) c
      from public.jobs j join public.leads l on l.id = j.lead_id
     where l.whatsapp_id like '55119999900%@s.whatsapp.net' and j.status = 'RUNNING'
     group by j.lead_id
  ) t;

  if v_por_lead > 1 then
    raise exception 'FALHOU: o mesmo lead foi claimado % vezes em paralelo', v_por_lead;
  end if;

  raise notice 'CONCORRÊNCIA OK: cada lead foi processado por um único worker';
end $$;
SQL

echo "== limpando"
$PSQL <<'SQL'
delete from public.jobs where lead_id in (
  select id from public.leads where whatsapp_id like '55119999900%@s.whatsapp.net'
);
delete from public.leads where whatsapp_id like '55119999900%@s.whatsapp.net';
SQL
