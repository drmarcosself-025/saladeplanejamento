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

echo "== limpando cenário 1"
$PSQL <<'SQL'
delete from public.jobs where lead_id in (
  select id from public.leads where whatsapp_id like '55119999900%@s.whatsapp.net'
);
delete from public.leads where whatsapp_id like '55119999900%@s.whatsapp.net';
SQL

# ============================================================================
# Cenário 2 — fencing sob concorrência REAL, não apenas em script serial.
#
# O teste transacional (turn_engine_test.sql) prova a LÓGICA de
# reserve_outbound_bubble chamando-a em sequência. Aqui, N processos disputam
# a MESMA reserva (mesmo job, mesmo worker, mesmo conteúdo) ao mesmo tempo de
# verdade — é o FOR UPDATE na linha do job que precisa serializar isso.
# Esperado: exatamente 1 "reserved":true, o resto "duplicado" (nunca duas
# linhas de bolha idênticas, nunca dois workers pensando que reservaram).
# ============================================================================
echo "== preparando cenário 2 (fencing sob concorrência real)"
LEAD_ID=$($PSQL -c "
  select (public.ingest_inbound_message(
    '5511999990020@s.whatsapp.net', '5511999990020', false, 'Fencing',
    'FENCE-1', 'TEXT', 'Oi', '{}'::jsonb, now(), 'h-fence1', null, null, false, null, 5, 30)
  )->>'lead_id';
")
LEAD_ID=$(echo "$LEAD_ID" | tr -d '[:space:]')

$PSQL -c "update public.jobs set run_after = now() where lead_id = '$LEAD_ID' and status = 'PENDING';" > /dev/null
CLAIM=$($PSQL -c "select job_id, turn_id from public.claim_lead_jobs('worker-fence', 1, 120);")
JOB_ID=$(echo "$CLAIM" | awk -F'|' 'NR==1{gsub(/ /,"",$1); print $1}')
TURN_ID=$(echo "$CLAIM" | awk -F'|' 'NR==1{gsub(/ /,"",$2); print $2}')

echo "== $WORKERS chamadas simultâneas de reserve_outbound_bubble para o mesmo job/conteúdo"
tmp2=$(mktemp -d)
for i in $(seq 1 "$WORKERS"); do
  (
    $PSQL -c "
      select (public.reserve_outbound_bubble(
        p_job_id => $JOB_ID, p_worker_id => 'worker-fence', p_lead_id => '$LEAD_ID',
        p_input_revision => 1, p_batch_ids => (select array_agg(id) from public.messages where lead_id = '$LEAD_ID' and direction = 'IN'),
        p_purpose => 'AI_REPLY', p_turn_id => '$TURN_ID', p_sequence => 1,
        p_text => 'Claro 😊', p_content_hash => 'hash-fence-bolha', p_dedupe_seconds => 120
      ))->>'reserved';
    " > "$tmp2/r$i.out" 2>&1
  ) &
done
wait

reserved_count=0
for i in $(seq 1 "$WORKERS"); do
  # ->>'reserved' extrai o booleano do jsonb como texto JSON ("true"/"false"),
  # não como boolean do Postgres ("t"/"f") — são representações diferentes.
  val=$(tr -d '[:space:]' < "$tmp2/r$i.out")
  if [ "$val" = "true" ]; then reserved_count=$((reserved_count + 1)); fi
done
rm -rf "$tmp2"

echo "reservas bem-sucedidas: $reserved_count (esperado: exatamente 1)"

$PSQL -c "
do \$\$
declare v_count int;
begin
  select count(*) into v_count from public.messages
   where lead_id = '$LEAD_ID' and direction = 'OUT' and content_hash = 'hash-fence-bolha';
  if v_count <> 1 then
    raise exception 'FALHOU: deveria existir exatamente 1 bolha gravada sob concorrência real, há %', v_count;
  end if;
  raise notice 'FENCING SOB CONCORRÊNCIA REAL OK: % chamada(s) simultânea(s), 1 única bolha gravada', $WORKERS;
end \$\$;
"

echo "== limpando cenário 2"
$PSQL -c "
delete from public.jobs where lead_id = '$LEAD_ID';
delete from public.leads where id = '$LEAD_ID';
"
