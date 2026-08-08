-- Projeto Marcos 30D — schema do módulo pessoal (Supabase)
-- Roda num projeto Supabase PRÓPRIO, separado do painel da clínica
-- (schema.sql fica no projeto "CRM D'OR ODONTOLOGIA"; este arquivo roda
-- no projeto pessoal "maison-dor-painel"). Cria as tabelas "p30_",
-- protegidas por RLS por usuário (auth.uid()) — como o projeto já é
-- outro, isso é isolamento em dobro: nem o banco é compartilhado, e
-- ainda assim ninguém além do próprio usuário lê ou escreve nas
-- linhas dele.
--
-- Este arquivo cobre só a fundação da Fase 2: ciclo de 30 dias, tarefas,
-- captura progressiva, rotinas por dia da semana, hábitos, metas/etapas
-- e a pontuação diária. Os módulos maiores (check-ins, alimentação,
-- água, peso, treino, financeiro, compras, notificações push) ficam
-- para as próximas fases, como migrations separadas — propositalmente
-- não criados ainda aqui.

create extension if not exists pgcrypto;

-- ============================================================
-- helper: updated_at automático (nome com prefixo p30_ pra não colidir
-- com nenhuma função do schema da clínica)
-- ============================================================
create or replace function public.p30_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- CYCLES — ciclo de 30 dias ("Dia X de 30"). O fuso horário fica
-- guardado no próprio ciclo (padrão America/Sao_Paulo, mas configurável
-- por ciclo — não é fixo no código).
-- ============================================================
create table if not exists public.p30_cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nome text not null default 'Ciclo 30 dias',
  data_inicio date not null,
  data_fim date not null,
  timezone text not null default 'America/Sao_Paulo',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists p30_cycles_user_idx on public.p30_cycles (user_id, ativo);

-- ============================================================
-- GOALS — metas (o "projeto"/"meta" da hierarquia projeto > meta >
-- marco > etapa semanal > sessão > tarefa; sessão e tarefa vivem em
-- p30_tasks, marco e etapa semanal em p30_goal_milestones).
-- ============================================================
create table if not exists public.p30_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid references public.p30_cycles(id) on delete set null,
  titulo text not null,
  area text check (area in ('corpo','mente','consultorio','futuro','organizacao')),
  data_inicio date not null default current_date,
  prazo_final date,
  motivo text,
  medida_sucesso text,
  -- como o progresso é medido — não só "tarefas concluídas" (pedido
  -- explícito: percentual, etapas, sessões, quantidade, frequência,
  -- peso ou valor financeiro)
  medida_tipo text not null default 'etapas'
    check (medida_tipo in ('percentual','etapas','sessoes','quantidade','frequencia','peso','valor')),
  meta_valor numeric,
  progresso_atual numeric not null default 0,
  frequencia_minima text,
  tempo_semanal_min integer,
  status text not null default 'ativa' check (status in ('ativa','pausada','concluida','arquivada')),
  nivel_risco text not null default 'no_ritmo' check (nivel_risco in ('no_ritmo','atencao','atrasada')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists p30_goals_user_idx on public.p30_goals (user_id, status);
drop trigger if exists trg_p30_goals_updated_at on public.p30_goals;
create trigger trg_p30_goals_updated_at before update on public.p30_goals
  for each row execute function public.p30_set_updated_at();

-- ============================================================
-- GOAL_MILESTONES — marcos e etapas semanais de uma meta.
-- ============================================================
create table if not exists public.p30_goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.p30_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  titulo text not null,
  tipo text not null default 'etapa_semanal' check (tipo in ('marco','etapa_semanal')),
  semana_referencia date,
  prazo date,
  concluido boolean not null default false,
  ordem integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists p30_goal_milestones_goal_idx on public.p30_goal_milestones (goal_id, ordem);
create index if not exists p30_goal_milestones_user_idx on public.p30_goal_milestones (user_id);

-- ============================================================
-- ROUTINES — rotinas recorrentes por dia da semana (0=domingo .. 6=sábado).
-- Geram ocorrências diárias em p30_task_occurrences.
-- ============================================================
create table if not exists public.p30_routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  titulo text not null,
  area text check (area in ('corpo','mente','consultorio','futuro','organizacao')),
  dias_semana smallint[] not null default '{0,1,2,3,4,5,6}',
  horario time,
  pontos integer not null default 10,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists p30_routines_user_idx on public.p30_routines (user_id, ativo);

-- ============================================================
-- TASKS — tudo que entra pela captura: tarefa, meta (referência
-- rápida), ideia, pensamento, preocupação ou "aguardando". O texto
-- original da captura é preservado (texto_original) mesmo depois de
-- organizado. "organizado=false" = ainda só o essencial (etapa 1 da
-- captura progressiva); tipo ideia/pensamento/preocupacao usam
-- status='registrado' e NUNCA aparecem como missão/obrigação —
-- só tipo tarefa/aguardando viram acionáveis (status='pendente').
-- ============================================================
create table if not exists public.p30_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid references public.p30_goals(id) on delete set null,
  cycle_id uuid references public.p30_cycles(id) on delete set null,
  titulo text not null,
  texto_original text,
  tipo text not null default 'tarefa'
    check (tipo in ('tarefa','meta','ideia','pensamento','preocupacao','aguardando')),
  area text check (area in ('corpo','mente','consultorio','futuro','organizacao')),
  status text not null default 'inbox'
    check (status in ('inbox','registrado','pendente','em_andamento','concluida','adiada','delegada','aguardando_terceiro','arquivada')),
  prioridade text check (prioridade in ('baixa','normal','alta')),
  data date,
  horario time,
  duracao_min integer,
  responsavel text,
  proxima_acao text,
  recorrencia jsonb,
  is_missao_hoje boolean not null default false,
  pontos integer not null default 10,
  observacao text,
  organizado boolean not null default false,
  concluido_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists p30_tasks_user_idx on public.p30_tasks (user_id, status);
create index if not exists p30_tasks_user_data_idx on public.p30_tasks (user_id, data);
create index if not exists p30_tasks_goal_idx on public.p30_tasks (goal_id);
drop trigger if exists trg_p30_tasks_updated_at on public.p30_tasks;
create trigger trg_p30_tasks_updated_at before update on public.p30_tasks
  for each row execute function public.p30_set_updated_at();

-- ============================================================
-- TASK_OCCURRENCES — a marcação de "feito/não feito" de uma rotina
-- num dia específico (a rotina em si não muda; só a ocorrência do dia).
-- ============================================================
create table if not exists public.p30_task_occurrences (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.p30_routines(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  data date not null,
  status text not null default 'pendente' check (status in ('pendente','concluida','pulada')),
  concluido_em timestamptz,
  created_at timestamptz not null default now(),
  unique (routine_id, data)
);
create index if not exists p30_task_occurrences_user_data_idx on public.p30_task_occurrences (user_id, data);

-- ============================================================
-- HABITS — hábitos essenciais diários (ou em dias específicos da semana).
-- ============================================================
create table if not exists public.p30_habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  titulo text not null,
  pontos integer not null default 8,
  dias_semana smallint[],
  ordem integer not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists p30_habits_user_idx on public.p30_habits (user_id, ativo);

-- ============================================================
-- HABIT_LOGS — marcação diária de um hábito.
-- ============================================================
create table if not exists public.p30_habit_logs (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references public.p30_habits(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  data date not null,
  concluido boolean not null default true,
  created_at timestamptz not null default now(),
  unique (habit_id, data)
);
create index if not exists p30_habit_logs_user_data_idx on public.p30_habit_logs (user_id, data);

-- ============================================================
-- DAILY_SCORES — fechamento de pontuação por dia (uma linha por
-- usuário+data). "fechado" marca se o dia foi encerrado pelo botão
-- "Encerrar meu dia". O teto (pontos_cap) fica salvo por linha pra
-- permitir ajuste futuro sem reescrever histórico.
-- ============================================================
create table if not exists public.p30_daily_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  data date not null,
  pontos_total integer not null default 0,
  pontos_cap integer not null default 150,
  missoes_concluidas integer not null default 0,
  missoes_total integer not null default 0,
  habitos_concluidos integer not null default 0,
  habitos_total integer not null default 0,
  fechado boolean not null default false,
  fechado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, data)
);
create index if not exists p30_daily_scores_user_data_idx on public.p30_daily_scores (user_id, data desc);
drop trigger if exists trg_p30_daily_scores_updated_at on public.p30_daily_scores;
create trigger trg_p30_daily_scores_updated_at before update on public.p30_daily_scores
  for each row execute function public.p30_set_updated_at();

-- ============================================================
-- PERMISSÕES — mesmo padrão do schema da clínica: quem está
-- autenticado pode operar nas tabelas; o RLS abaixo restringe cada
-- linha ao próprio dono.
-- ============================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.p30_cycles, public.p30_goals, public.p30_goal_milestones,
  public.p30_routines, public.p30_tasks, public.p30_task_occurrences,
  public.p30_habits, public.p30_habit_logs, public.p30_daily_scores
to authenticated;

-- ============================================================
-- ROW LEVEL SECURITY — só o próprio usuário lê/escreve nas suas linhas.
-- Diferente das tabelas da clínica (using (true), dado de equipe),
-- aqui é dado pessoal: nunca `true`.
-- ============================================================
alter table public.p30_cycles enable row level security;
alter table public.p30_goals enable row level security;
alter table public.p30_goal_milestones enable row level security;
alter table public.p30_routines enable row level security;
alter table public.p30_tasks enable row level security;
alter table public.p30_task_occurrences enable row level security;
alter table public.p30_habits enable row level security;
alter table public.p30_habit_logs enable row level security;
alter table public.p30_daily_scores enable row level security;

create policy "p30_cycles_owner" on public.p30_cycles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_goals_owner" on public.p30_goals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_goal_milestones_owner" on public.p30_goal_milestones for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_routines_owner" on public.p30_routines for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_tasks_owner" on public.p30_tasks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_task_occurrences_owner" on public.p30_task_occurrences for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_habits_owner" on public.p30_habits for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_habit_logs_owner" on public.p30_habit_logs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "p30_daily_scores_owner" on public.p30_daily_scores for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- MIGRATION ADITIVA — carga inicial idempotente ("Configurar meu
-- Projeto 30D"). Nada aqui altera ou apaga dado existente. Reversível:
-- a coluna pode ser removida e a tabela pode ser dropada sem afetar o
-- restante do schema, se um dia isso deixar de ser necessário.
-- ============================================================

-- p30_tasks.is_missao_hoje era um booleano global, sem data — uma
-- tarefa marcada como missão continuava aparecendo como "missão de
-- hoje" em qualquer dia futuro, para sempre, até alguém desmarcar
-- manualmente. missao_data amarra a marcação a um dia específico;
-- o app passa a filtrar is_missao_hoje=true AND missao_data=hoje.
alter table public.p30_tasks add column if not exists missao_data date;
create index if not exists p30_tasks_missao_data_idx on public.p30_tasks (user_id, missao_data);

-- ============================================================
-- SETUP_PROPOSALS — sugestões da carga inicial, separadas das
-- tabelas reais. Nada aparece em p30_tasks/p30_habits/p30_routines/
-- p30_goals até o usuário confirmar item a item na tela "Configurar
-- meu Projeto 30D". "slug" é a chave estável de idempotência: rodar a
-- semeadura de novo nunca duplica nem reseta uma decisão já tomada
-- (upsert com "do nothing" em conflito). created_target_id guarda o id
-- da linha real criada na confirmação, usado tanto pra não confirmar
-- duas vezes quanto para o rollback (remover só o que essa carga criou).
-- ============================================================
create table if not exists public.p30_setup_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  categoria text not null check (categoria in ('rotina','habito','meta','marco','etapa','tarefa')),
  titulo text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'sugerido' check (status in ('sugerido','confirmado','descartado')),
  created_target_table text,
  created_target_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
create index if not exists p30_setup_proposals_user_idx on public.p30_setup_proposals (user_id, status);
drop trigger if exists trg_p30_setup_proposals_updated_at on public.p30_setup_proposals;
create trigger trg_p30_setup_proposals_updated_at before update on public.p30_setup_proposals
  for each row execute function public.p30_set_updated_at();

grant select, insert, update, delete on public.p30_setup_proposals to authenticated;
alter table public.p30_setup_proposals enable row level security;
drop policy if exists "p30_setup_proposals_owner" on public.p30_setup_proposals;
create policy "p30_setup_proposals_owner" on public.p30_setup_proposals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- PAINEL DO TCC — colunas novas em p30_goal_milestones (peso da etapa,
-- descrição, datas, observação, próxima ação) + histórico de
-- progresso. Tudo aditivo, nada apaga ou altera dado existente —
-- etapas já criadas continuam do jeito que estavam, só ganham campos
-- novos vazios até o usuário preencher.
-- ============================================================
alter table public.p30_goal_milestones add column if not exists peso numeric;
alter table public.p30_goal_milestones add column if not exists descricao text;
alter table public.p30_goal_milestones add column if not exists data_inicio date;
alter table public.p30_goal_milestones add column if not exists data_conclusao date;
alter table public.p30_goal_milestones add column if not exists observacao text;
alter table public.p30_goal_milestones add column if not exists proxima_acao text;

create table if not exists public.p30_goal_progress_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.p30_goals(id) on delete cascade,
  milestone_id uuid references public.p30_goal_milestones(id) on delete set null,
  data date not null default current_date,
  percentual_anterior numeric,
  percentual_novo numeric,
  observacao text,
  created_at timestamptz not null default now()
);
create index if not exists p30_goal_progress_log_goal_idx on public.p30_goal_progress_log (goal_id, created_at desc);

grant select, insert, update, delete on public.p30_goal_progress_log to authenticated;
alter table public.p30_goal_progress_log enable row level security;
drop policy if exists "p30_goal_progress_log_owner" on public.p30_goal_progress_log;
create policy "p30_goal_progress_log_owner" on public.p30_goal_progress_log for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Rollback: drop table p30_goal_progress_log;
--           alter table p30_goal_milestones drop column peso, drop column descricao,
--             drop column data_inicio, drop column data_conclusao, drop column observacao,
--             drop column proxima_acao;

-- ============================================================
-- ROLLBACK desta migration (rodar manualmente, só se decidir reverter):
--
--   drop table if exists public.p30_setup_proposals;
--   drop index if exists public.p30_tasks_missao_data_idx;
--   alter table public.p30_tasks drop column if exists missao_data;
--
-- Isso não apaga nenhuma tarefa/hábito/rotina/meta real — só o
-- mecanismo de proposta e a coluna de data da missão. Para desfazer
-- especificamente os dados CRIADOS pela carga inicial (sem remover o
-- mecanismo em si), use o botão "Desfazer carga inicial" nos Ajustes
-- do app — ele apaga apenas as linhas cujo id está registrado em
-- p30_setup_proposals.created_target_id, devolvendo cada proposta
-- para o estado "sugerido".
-- ============================================================
