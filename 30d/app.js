// ============================================================
// Projeto Marcos 30D — app.js
// Projeto Supabase PRÓPRIO, separado do painel da clínica (produto
// pessoal, não o CRM de equipe) — auth e dados isolados de ponta a
// ponta, não só por RLS. Nenhuma chave privada aqui — a anon/publishable
// key é pública por design do Supabase; a proteção de verdade é o RLS
// (ver supabase/schema-30d.sql).
// ============================================================
(function () {
  'use strict';

  var SUPABASE_URL = 'https://nqumpsmxtqvvxvssdhai.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_7n5RIgoUqgyuP6u37x3kcA_Nt8hMFlA';
  var DEFAULT_TZ = 'America/Sao_Paulo';
  var CAP = 150;
  var CYCLE_LENGTH_DAYS = 30;

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  var AREA_LABEL = { corpo: 'Corpo', mente: 'Mente', consultorio: 'Consultório', futuro: 'Futuro', organizacao: 'Organização' };
  var DAY_ABBR = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  var DAY_FULL = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var WD_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // ------------------------------------------------------------
  // datas / fuso horário — sempre calculado a partir do relógio real,
  // no fuso do ciclo ativo (padrão America/Sao_Paulo), nunca a partir
  // do fuso local do navegador.
  // ------------------------------------------------------------
  function todayStr(tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function weekdayIdx(tz) {
    var s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date());
    return WD_MAP[s];
  }
  function nowTimeStr(tz) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  }
  function dateParts(dateStr) {
    var p = dateStr.split('-');
    return { y: +p[0], m: +p[1], d: +p[2] };
  }
  function addDaysStr(dateStr, days) {
    var p = dateParts(dateStr);
    var d = new Date(Date.UTC(p.y, p.m - 1, p.d));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function diffDaysStr(aStr, bStr) {
    var a = dateParts(aStr), b = dateParts(bStr);
    var ua = Date.UTC(a.y, a.m - 1, a.d), ub = Date.UTC(b.y, b.m - 1, b.d);
    return Math.round((ub - ua) / 86400000);
  }
  function formatFullDate(tz) {
    var now = new Date();
    var wd = DAY_FULL[weekdayIdx(tz)];
    var d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: 'numeric' }).format(now);
    var mIdx = +new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'numeric' }).format(now) - 1;
    return (wd + ', ' + d + ' de ' + MONTHS[mIdx]).toUpperCase();
  }

  // ------------------------------------------------------------
  // estado em memória da sessão
  // ------------------------------------------------------------
  var state = {
    user: null,
    tz: DEFAULT_TZ,
    today: null,
    weekday: null,
    cycle: null,
    missions: [],       // tasks com is_missao_hoje
    habits: [],         // {habit, done}
    routinesToday: [],  // {routine, occurrence}
    goals: [],
    weeklyMilestone: null, // {milestone, goal}
    deadlineGoal: null,
    nextCommitment: null,
    score: { pontos: 0, cap: CAP, streak: 0 }
  };

  var el = {};
  function q(id) { return document.getElementById(id); }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.classList.remove('show'); }, 2400);
  }

  function iconCheck() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="#0e0d0c" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  }

  // ============================================================
  // AUTH
  // ============================================================
  function initAuthScreen() {
    var mode = 'entrar';
    q('authTabEntrar').addEventListener('click', function () { setAuthMode('entrar'); });
    q('authTabCriar').addEventListener('click', function () { setAuthMode('criar'); });
    function setAuthMode(m) {
      mode = m;
      q('authTabEntrar').classList.toggle('active', m === 'entrar');
      q('authTabCriar').classList.toggle('active', m === 'criar');
      q('authSubmitBtn').textContent = m === 'entrar' ? 'Entrar' : 'Criar conta';
      q('authError').classList.remove('show');
    }
    q('authSubmitBtn').addEventListener('click', function () {
      var email = q('authEmail').value.trim();
      var senha = q('authSenha').value;
      if (!email || !senha) { showAuthError('Preencha e-mail e senha.'); return; }
      q('authSubmitBtn').disabled = true;
      var p = mode === 'entrar'
        ? sb.auth.signInWithPassword({ email: email, password: senha })
        : sb.auth.signUp({ email: email, password: senha });
      p.then(function (res) {
        q('authSubmitBtn').disabled = false;
        if (res.error) { showAuthError(res.error.message); return; }
        if (mode === 'criar' && res.data && res.data.user && !res.data.session) {
          showAuthError('Conta criada. Confirme seu e-mail e depois entre.');
          return;
        }
        onAuthed(res.data.session.user);
      });
    });
    function showAuthError(msg) {
      q('authError').textContent = msg;
      q('authError').classList.add('show');
    }
  }

  function boot() {
    sb.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session && session.user) { onAuthed(session.user); }
      else { showAuth(); }
    });
    sb.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_OUT') { showAuth(); }
    });
  }

  function showAuth() {
    q('loadingScreen').hidden = true;
    q('authScreen').hidden = false;
    q('appRoot').hidden = true;
  }

  function onAuthed(user) {
    state.user = user;
    q('authScreen').hidden = true;
    q('loadingScreen').hidden = false;
    q('appRoot').hidden = true;
    loadEverything();
  }

  // ============================================================
  // CARGA DE DADOS
  // ============================================================
  function loadEverything() {
    state.tz = DEFAULT_TZ;
    state.today = todayStr(state.tz);
    state.weekday = weekdayIdx(state.tz);

    ensureCycle()
      .then(function () {
        return Promise.all([
          loadMissions(),
          loadHabits(),
          loadRoutinesToday(),
          loadGoals(),
          loadDailyScore()
        ]);
      })
      .then(function () {
        computeNextCommitment();
        computeWeeklyMilestone();
        computeDeadlineChip();
        renderAll();
        q('loadingScreen').hidden = true;
        q('appRoot').hidden = false;
        q('errorBanner').hidden = true;
      })
      .catch(function (err) {
        console.error('[30D] falha ao carregar', err);
        q('loadingScreen').hidden = true;
        q('appRoot').hidden = false;
        q('errorBanner').hidden = false;
        q('errorBannerMsg').textContent = 'Não consegui carregar seus dados agora.';
      });
  }

  function ensureCycle() {
    return sb.from('p30_cycles').select('*').eq('user_id', state.user.id).eq('ativo', true)
      .order('data_inicio', { ascending: false }).limit(1)
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data && res.data.length) { state.cycle = res.data[0]; return; }
        var novo = {
          user_id: state.user.id, nome: 'Ciclo 1', data_inicio: state.today,
          data_fim: addDaysStr(state.today, CYCLE_LENGTH_DAYS - 1), timezone: state.tz, ativo: true
        };
        return sb.from('p30_cycles').insert(novo).select().single().then(function (r) {
          if (r.error) throw r.error;
          state.cycle = r.data;
        });
      });
  }

  function loadMissions() {
    return sb.from('p30_tasks').select('*').eq('user_id', state.user.id).eq('is_missao_hoje', true)
      .in('status', ['pendente', 'em_andamento', 'concluida']).order('created_at', { ascending: true }).limit(3)
      .then(function (res) {
        if (res.error) throw res.error;
        state.missions = (res.data || []).map(function (t) { return { task: t, done: t.status === 'concluida' }; });
      });
  }

  function loadHabits() {
    return sb.from('p30_habits').select('*').eq('user_id', state.user.id).eq('ativo', true).order('ordem', { ascending: true })
      .then(function (res) {
        if (res.error) throw res.error;
        var habits = (res.data || []).filter(function (h) { return !h.dias_semana || h.dias_semana.indexOf(state.weekday) !== -1; });
        return sb.from('p30_habit_logs').select('habit_id').eq('user_id', state.user.id).eq('data', state.today)
          .then(function (r2) {
            if (r2.error) throw r2.error;
            var doneIds = {};
            (r2.data || []).forEach(function (l) { doneIds[l.habit_id] = true; });
            state.habits = habits.map(function (h) { return { habit: h, done: !!doneIds[h.id] }; });
          });
      });
  }

  function loadRoutinesToday() {
    return sb.from('p30_routines').select('*').eq('user_id', state.user.id).eq('ativo', true)
      .then(function (res) {
        if (res.error) throw res.error;
        var routines = (res.data || []).filter(function (r) { return r.dias_semana && r.dias_semana.indexOf(state.weekday) !== -1; });
        if (!routines.length) { state.routinesToday = []; return; }
        var ids = routines.map(function (r) { return r.id; });
        return sb.from('p30_task_occurrences').select('*').eq('user_id', state.user.id).eq('data', state.today).in('routine_id', ids)
          .then(function (r2) {
            if (r2.error) throw r2.error;
            var byRoutine = {};
            (r2.data || []).forEach(function (o) { byRoutine[o.routine_id] = o; });
            var missing = routines.filter(function (r) { return !byRoutine[r.id]; });
            var createMissing = missing.length
              ? sb.from('p30_task_occurrences').insert(missing.map(function (r) {
                  return { routine_id: r.id, user_id: state.user.id, data: state.today, status: 'pendente' };
                })).select()
              : Promise.resolve({ data: [], error: null });
            return createMissing.then(function (r3) {
              if (r3.error) throw r3.error;
              (r3.data || []).forEach(function (o) { byRoutine[o.routine_id] = o; });
              state.routinesToday = routines.map(function (r) { return { routine: r, occurrence: byRoutine[r.id] }; });
            });
          });
      });
  }

  function loadGoals() {
    return sb.from('p30_goals').select('*, p30_goal_milestones(*)').eq('user_id', state.user.id).eq('status', 'ativa')
      .order('prazo_final', { ascending: true, nullsFirst: false })
      .then(function (res) {
        if (res.error) throw res.error;
        state.goals = res.data || [];
      });
  }

  function loadDailyScore() {
    return sb.from('p30_daily_scores').select('*').eq('user_id', state.user.id)
      .order('data', { ascending: false }).limit(60)
      .then(function (res) {
        if (res.error) throw res.error;
        state.scoreHistory = res.data || [];
      });
  }

  function computeWeeklyMilestone() {
    state.weeklyMilestone = null;
    for (var i = 0; i < state.goals.length; i++) {
      var g = state.goals[i];
      var ms = (g.p30_goal_milestones || []).filter(function (m) { return m.tipo === 'etapa_semanal' && !m.concluido; });
      ms.sort(function (a, b) { return (a.prazo || '9999') < (b.prazo || '9999') ? -1 : 1; });
      if (ms.length) { state.weeklyMilestone = { milestone: ms[0], goal: g }; break; }
    }
  }

  function computeDeadlineChip() {
    state.deadlineGoal = null;
    var limit = addDaysStr(state.today, 5);
    var candidates = state.goals.filter(function (g) { return g.prazo_final && g.prazo_final >= state.today && g.prazo_final <= limit; });
    candidates.sort(function (a, b) { return a.prazo_final < b.prazo_final ? -1 : 1; });
    if (candidates.length) state.deadlineGoal = candidates[0];
  }

  function computeNextCommitment() {
    var now = nowTimeStr(state.tz);
    var items = [];
    state.missions.forEach(function (m) {
      var forToday = !m.task.data || m.task.data === state.today;
      if (m.task.horario && forToday && m.task.status !== 'concluida') {
        items.push({ horario: m.task.horario, titulo: m.task.titulo });
      }
    });
    state.routinesToday.forEach(function (r) {
      if (r.routine.horario && r.occurrence && r.occurrence.status === 'pendente') {
        items.push({ horario: r.routine.horario, titulo: r.routine.titulo });
      }
    });
    items = items.filter(function (i) { return i.horario >= now; });
    items.sort(function (a, b) { return a.horario < b.horario ? -1 : 1; });
    state.nextCommitment = items[0] || null;
  }

  // ============================================================
  // PONTUAÇÃO
  // ============================================================
  function currentPoints() {
    var pts = 0;
    state.missions.forEach(function (m) { if (m.done) pts += m.task.pontos || 0; });
    state.habits.forEach(function (h) { if (h.done) pts += h.habit.pontos || 0; });
    state.routinesToday.forEach(function (r) { if (r.occurrence && r.occurrence.status === 'concluida') pts += r.routine.pontos || 0; });
    return Math.min(pts, CAP);
  }

  function computeStreak(pontosHoje) {
    var byDate = {};
    (state.scoreHistory || []).forEach(function (s) { byDate[s.data] = s.pontos_total; });
    byDate[state.today] = pontosHoje;
    var cursor = state.today;
    var streak = 0;
    if (byDate[cursor] > 0) { streak++; cursor = addDaysStr(cursor, -1); }
    else { cursor = addDaysStr(cursor, -1); }
    var guard = 0;
    while (byDate[cursor] > 0 && guard < 90) { streak++; cursor = addDaysStr(cursor, -1); guard++; }
    return streak;
  }

  function persistDailyScore() {
    var pts = currentPoints();
    var streak = computeStreak(pts);
    state.score = { pontos: pts, cap: CAP, streak: streak };
    var missoesConcluidas = state.missions.filter(function (m) { return m.done; }).length;
    var habitosConcluidos = state.habits.filter(function (h) { return h.done; }).length
      + state.routinesToday.filter(function (r) { return r.occurrence && r.occurrence.status === 'concluida'; }).length;
    var row = {
      user_id: state.user.id, data: state.today, pontos_total: pts, pontos_cap: CAP,
      missoes_concluidas: missoesConcluidas, missoes_total: state.missions.length,
      habitos_concluidos: habitosConcluidos, habitos_total: state.habits.length + state.routinesToday.length
    };
    sb.from('p30_daily_scores').upsert(row, { onConflict: 'user_id,data' }).then(function (res) {
      if (res.error) console.error('[30D] falha ao salvar pontuação', res.error);
    });
    renderScore();
  }

  // ============================================================
  // RENDER
  // ============================================================
  function renderAll() {
    renderHeader();
    renderInfoChips();
    renderWeeklyGoal();
    renderMissions();
    renderHabits();
    renderRoutinesToday();
    renderNext();
    state.score.pontos = currentPoints();
    state.score.streak = computeStreak(state.score.pontos);
    renderScore();
  }

  function renderHeader() {
    var now = new Date();
    var h = +new Intl.DateTimeFormat('en-GB', { timeZone: state.tz, hour: '2-digit', hour12: false }).format(now);
    var saud = h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    var nome = (state.user.user_metadata && state.user.user_metadata.nome) || 'Marcos';
    q('greeting').innerHTML = saud + ', ' + nome.split(' ')[0] + '<span class="accent">.</span>';
    q('dateLabel').textContent = formatFullDate(state.tz);
    var dayNum = Math.min(Math.max(diffDaysStr(state.cycle.data_inicio, state.today) + 1, 1), CYCLE_LENGTH_DAYS);
    q('cycleChip').textContent = 'Dia ' + dayNum + ' de ' + CYCLE_LENGTH_DAYS;
  }

  function renderInfoChips() {
    var wrap = el.infoChips;
    wrap.innerHTML = '';
    if (state.deadlineGoal) {
      var dias = diffDaysStr(state.today, state.deadlineGoal.prazo_final);
      var div = document.createElement('div');
      div.className = 'info-chip warn';
      div.innerHTML = '<span class="ic">' + svgAlert() + '</span><span><b>' + esc(state.deadlineGoal.titulo) + '</b> — prazo em ' + dias + (dias === 1 ? ' dia' : ' dias') + '</span>';
      wrap.appendChild(div);
    }
    wrap.hidden = wrap.children.length === 0;
  }

  function renderWeeklyGoal() {
    var box = el.weeklyGoal;
    if (!state.weeklyMilestone) { box.hidden = true; return; }
    box.hidden = false;
    box.querySelector('.title').textContent = state.weeklyMilestone.milestone.titulo;
    box.querySelector('.eyebrow').textContent = 'Meta da semana · ' + state.weeklyMilestone.goal.titulo;
  }

  function renderMissions() {
    var wrap = el.missionsList;
    if (!state.missions.length) {
      wrap.innerHTML = '';
      el.missionsEmpty.hidden = false;
      el.restBanner.classList.remove('show');
      return;
    }
    el.missionsEmpty.hidden = true;
    wrap.innerHTML = state.missions.map(function (m, i) {
      return '<div class="mission' + (m.done ? ' done' : '') + '" data-i="' + i + '">' +
        '<span class="check">' + iconCheck() + '</span>' +
        '<span class="mission-body"><span class="mission-title">' + esc(m.task.titulo) + '</span>' +
        '<span class="mission-meta">' + (AREA_LABEL[m.task.area] || 'Sem área') + '</span></span>' +
        '<span class="mission-pts">' + (m.done ? 'Concluída' : '+' + m.task.pontos) + '</span>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('.mission'), function (node) {
      node.addEventListener('click', function () { toggleMission(+node.dataset.i); });
    });
    var allDone = state.missions.every(function (m) { return m.done; });
    el.restBanner.classList.toggle('show', allDone);
  }

  function toggleMission(i) {
    var m = state.missions[i];
    m.done = !m.done;
    var newStatus = m.done ? 'concluida' : 'pendente';
    m.task.status = newStatus;
    sb.from('p30_tasks').update({ status: newStatus, concluido_em: m.done ? new Date().toISOString() : null })
      .eq('id', m.task.id).then(function (res) { if (res.error) console.error(res.error); });
    renderMissions();
    persistDailyScore();
  }

  function renderHabits() {
    var wrap = el.habitsList;
    wrap.innerHTML = state.habits.map(function (h, i) {
      return '<div class="habit-row' + (h.done ? ' done' : '') + '" data-i="' + i + '">' +
        '<span class="habit-check">' + iconCheck() + '</span>' +
        '<span class="t">' + esc(h.habit.titulo) + '</span>' +
        '<span class="p">+' + h.habit.pontos + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('.habit-row'), function (node) {
      node.addEventListener('click', function () { toggleHabit(+node.dataset.i); });
    });
    q('habitsCount').textContent = state.habits.filter(function (h) { return h.done; }).length + ' de ' + state.habits.length;
  }

  function toggleHabit(i) {
    var h = state.habits[i];
    h.done = !h.done;
    var p = h.done
      ? sb.from('p30_habit_logs').insert({ habit_id: h.habit.id, user_id: state.user.id, data: state.today, concluido: true })
      : sb.from('p30_habit_logs').delete().eq('habit_id', h.habit.id).eq('user_id', state.user.id).eq('data', state.today);
    p.then(function (res) { if (res.error) console.error(res.error); });
    renderHabits();
    persistDailyScore();
  }

  function renderRoutinesToday() {
    var box = el.routinesBox;
    if (!state.routinesToday.length) { box.hidden = true; return; }
    box.hidden = false;
    q('routinesTitle').textContent = 'Rotinas de ' + DAY_FULL[state.weekday].replace('-feira', '');
    var doneCount = state.routinesToday.filter(function (r) { return r.occurrence.status === 'concluida'; }).length;
    q('routinesCount').textContent = doneCount + ' de ' + state.routinesToday.length;
    el.routinesList.innerHTML = state.routinesToday.map(function (r, i) {
      var done = r.occurrence.status === 'concluida';
      return '<div class="habit-row' + (done ? ' done' : '') + '" data-i="' + i + '">' +
        '<span class="habit-check">' + iconCheck() + '</span>' +
        '<span class="t">' + esc(r.routine.titulo) + (r.routine.horario ? ' · ' + r.routine.horario.slice(0, 5) : '') + '</span>' +
        '<span class="p">+' + r.routine.pontos + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(el.routinesList.querySelectorAll('.habit-row'), function (node) {
      node.addEventListener('click', function () { toggleRoutine(+node.dataset.i); });
    });
  }

  function toggleRoutine(i) {
    var r = state.routinesToday[i];
    var newStatus = r.occurrence.status === 'concluida' ? 'pendente' : 'concluida';
    r.occurrence.status = newStatus;
    sb.from('p30_task_occurrences').update({ status: newStatus, concluido_em: newStatus === 'concluida' ? new Date().toISOString() : null })
      .eq('id', r.occurrence.id).then(function (res) { if (res.error) console.error(res.error); });
    renderRoutinesToday();
    computeNextCommitment();
    renderNext();
    persistDailyScore();
  }

  function renderNext() {
    if (!state.nextCommitment) { el.nextBox.hidden = true; return; }
    el.nextBox.hidden = false;
    el.nextBox.querySelector('.time').textContent = state.nextCommitment.horario.slice(0, 5).toUpperCase();
    el.nextBox.querySelector('.title').textContent = state.nextCommitment.titulo;
  }

  function renderScore() {
    q('ptsNow').textContent = state.score.pontos;
    q('ptsCap').textContent = 'de ' + CAP + ' pontos';
    q('streakNum').textContent = state.score.streak;
    var mDone = state.missions.filter(function (m) { return m.done; }).length;
    q('missionsNum').textContent = mDone + '/' + state.missions.length;
    var hDone = state.habits.filter(function (h) { return h.done; }).length + state.routinesToday.filter(function (r) { return r.occurrence.status === 'concluida'; }).length;
    var hTotal = state.habits.length + state.routinesToday.length;
    q('habitsNum').textContent = hDone + '/' + hTotal;
    var frac = state.score.pontos / CAP;
    var RING_LEN = 465;
    el.ringFg.setAttribute('stroke-dashoffset', String(RING_LEN * (1 - frac)));
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function svgAlert() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 2.7 17.6a1.5 1.5 0 0 0 1.3 2.2h16a1.5 1.5 0 0 0 1.3-2.2L13.7 3.9a1.5 1.5 0 0 0-2.6 0Z"/></svg>';
  }

  // ============================================================
  // CAPTURA PROGRESSIVA
  // ============================================================
  function initCapture() {
    var stage2Open = false;
    var selectedArea = null;
    var selectedTipo = 'tarefa';
    var selectedPrioridade = null;
    var currentTaskId = null;
    var days2 = [0, 1, 2, 3, 4, 5, 6];

    q('areaChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x === b); });
      selectedArea = b.dataset.a;
    });
    q('tipoChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x === b); });
      selectedTipo = b.dataset.tipo;
    });
    q('prioridadeChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x === b); });
      selectedPrioridade = b.dataset.p;
    });

    function resetCapture() {
      q('captureInput').value = '';
      q('capPrazo').value = ''; q('capHorario').value = ''; q('capDuracao').value = '';
      q('capResponsavel').value = ''; q('capProximaAcao').value = ''; q('capObs').value = '';
      q('capMeta').value = '';
      selectedArea = null; selectedTipo = 'tarefa'; selectedPrioridade = null; currentTaskId = null;
      Array.prototype.forEach.call(q('areaChips').querySelectorAll('.chip'), function (x) { x.classList.remove('active'); });
      Array.prototype.forEach.call(q('tipoChips').querySelectorAll('.chip'), function (x, i) { x.classList.toggle('active', i === 0); });
      Array.prototype.forEach.call(q('prioridadeChips').querySelectorAll('.chip'), function (x) { x.classList.remove('active'); });
      stage2Open = false;
      q('captureStage2').hidden = true;
      q('captureStage1Actions').hidden = false;
    }

    function openCapture() {
      resetCapture();
      populateMetaSelect();
      el.scrim.classList.add('show');
      el.sheetCapture.classList.add('show');
      setTimeout(function () { q('captureInput').focus(); }, 260);
    }
    function closeCapture() {
      el.scrim.classList.remove('show');
      el.sheetCapture.classList.remove('show');
    }
    q('captureBtn').addEventListener('click', openCapture);
    q('fabBtn').addEventListener('click', openCapture);

    function populateMetaSelect() {
      var sel = q('capMeta');
      sel.innerHTML = '<option value="">Nenhuma</option>' + state.goals.map(function (g) {
        return '<option value="' + g.id + '">' + esc(g.titulo) + '</option>';
      }).join('');
    }

    q('organizeBtn').addEventListener('click', function () {
      stage2Open = true;
      q('captureStage2').hidden = false;
      q('captureStage1Actions').hidden = true;
    });

    q('saveCaptureBtn').addEventListener('click', function () {
      var titulo = q('captureInput').value.trim();
      if (!titulo) { toast('Escreva algo antes de salvar.'); return; }
      var row = {
        user_id: state.user.id, titulo: titulo, texto_original: titulo,
        area: selectedArea, tipo: 'tarefa', status: 'inbox', organizado: false, pontos: 10
      };
      q('saveCaptureBtn').disabled = true;
      sb.from('p30_tasks').insert(row).select().single().then(function (res) {
        q('saveCaptureBtn').disabled = false;
        if (res.error) { toast('Não consegui salvar. Tente de novo.'); console.error(res.error); return; }
        closeCapture();
        toast('Pendência capturada.');
      });
    });

    q('organizeSaveBtn').addEventListener('click', function () {
      var titulo = q('captureInput').value.trim();
      if (!titulo) { toast('Escreva algo antes de salvar.'); return; }
      var isObrigacao = selectedTipo === 'tarefa' || selectedTipo === 'aguardando';
      var status = selectedTipo === 'aguardando' ? 'aguardando_terceiro' : (isObrigacao ? 'pendente' : 'registrado');
      var recorrenciaSel = q('capRecorrencia').value;
      var row = {
        user_id: state.user.id, titulo: titulo, texto_original: titulo,
        area: selectedArea, tipo: selectedTipo, status: status, organizado: true,
        data: q('capPrazo').value || null, horario: q('capHorario').value || null,
        duracao_min: q('capDuracao').value ? +q('capDuracao').value : null,
        prioridade: selectedPrioridade, responsavel: q('capResponsavel').value.trim() || null,
        proxima_acao: q('capProximaAcao').value.trim() || null, observacao: q('capObs').value.trim() || null,
        goal_id: q('capMeta').value || null, cycle_id: state.cycle.id,
        recorrencia: recorrenciaSel === 'nenhuma' ? null : { tipo: recorrenciaSel },
        pontos: selectedPrioridade === 'alta' ? 20 : selectedPrioridade === 'baixa' ? 8 : 10
      };
      q('organizeSaveBtn').disabled = true;
      sb.from('p30_tasks').insert(row).select().single().then(function (res) {
        q('organizeSaveBtn').disabled = false;
        if (res.error) { toast('Não consegui salvar. Tente de novo.'); console.error(res.error); return; }
        closeCapture();
        toast(isObrigacao ? 'Tarefa organizada.' : 'Registrado — isso não vira obrigação automaticamente.');
        if (row.data === state.today || !row.data) { loadMissions().then(renderMissions); }
      });
    });
  }

  // ============================================================
  // REORGANIZAR (escolher até 3 missões)
  // ============================================================
  function initReorganize() {
    var selected = {};
    q('reorganizeBtn').addEventListener('click', openReorganize);

    function openReorganize() {
      selected = {};
      state.missions.forEach(function (m) { selected[m.task.id] = true; });
      sb.from('p30_tasks').select('*').eq('user_id', state.user.id)
        .in('status', ['inbox', 'pendente', 'em_andamento'])
        .in('tipo', ['tarefa', 'aguardando'])
        .or('data.is.null,data.lte.' + state.today)
        .order('created_at', { ascending: true }).limit(40)
        .then(function (res) {
          if (res.error) { toast('Não consegui carregar suas tarefas.'); console.error(res.error); return; }
          renderReorganizeList(res.data || []);
          el.scrim.classList.add('show');
          el.sheetReorganize.classList.add('show');
        });
    }
    function closeReorganize() {
      el.scrim.classList.remove('show');
      el.sheetReorganize.classList.remove('show');
    }
    q('reorganizeCancelBtn').addEventListener('click', closeReorganize);

    function renderReorganizeList(tasks) {
      el.reorganizeList.innerHTML = tasks.length ? tasks.map(function (t) {
        return '<label class="mini-row" style="cursor:pointer;">' +
          '<input type="checkbox" data-id="' + t.id + '"' + (selected[t.id] ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:#c3a35f;flex:0 0 auto;">' +
          '<span class="mbody"><span class="mtitle">' + esc(t.titulo) + '</span>' +
          '<span class="mmeta">' + (AREA_LABEL[t.area] || 'Sem área') + '</span></span></label>';
      }).join('') : '<div class="empty-state">Nada pendente pra organizar agora. Use a captura pra adicionar algo.</div>';
      Array.prototype.forEach.call(el.reorganizeList.querySelectorAll('input[type=checkbox]'), function (cb) {
        cb.addEventListener('change', function () {
          var checkedCount = Object.keys(selected).filter(function (k) { return selected[k]; }).length;
          if (cb.checked && checkedCount >= 3) { cb.checked = false; toast('No máximo 3 missões por vez.'); return; }
          selected[cb.dataset.id] = cb.checked;
        });
      });
    }

    q('reorganizeSaveBtn').addEventListener('click', function () {
      var chosenIds = Object.keys(selected).filter(function (k) { return selected[k]; });
      if (!chosenIds.length) { toast('Escolha ao menos uma missão.'); return; }
      var previouslyMissionIds = state.missions.map(function (m) { return m.task.id; });
      var toUnset = previouslyMissionIds.filter(function (id) { return chosenIds.indexOf(id) === -1; });
      q('reorganizeSaveBtn').disabled = true;
      var ops = [];
      chosenIds.forEach(function (id) {
        ops.push(sb.from('p30_tasks').update({ is_missao_hoje: true, status: 'pendente' }).eq('id', id).eq('status', 'inbox'));
        ops.push(sb.from('p30_tasks').update({ is_missao_hoje: true }).eq('id', id).neq('status', 'inbox'));
      });
      toUnset.forEach(function (id) { ops.push(sb.from('p30_tasks').update({ is_missao_hoje: false }).eq('id', id)); });
      Promise.all(ops).then(function () {
        q('reorganizeSaveBtn').disabled = false;
        closeReorganize();
        toast('Seu dia foi reorganizado.');
        loadMissions().then(function () { renderMissions(); persistDailyScore(); computeNextCommitment(); renderNext(); });
      });
    });
  }

  // ============================================================
  // "ESTOU COM A CABEÇA CHEIA" — versão inicial: preserva o texto
  // integral como um pensamento registrado. A separação guiada em
  // itens específicos (ação, meta, ideia, preocupação...) é da Fase 3.
  // ============================================================
  function initBraindump() {
    q('braindumpBtn').addEventListener('click', function () {
      q('braindumpText').value = '';
      el.scrim.classList.add('show');
      el.sheetBraindump.classList.add('show');
      setTimeout(function () { q('braindumpText').focus(); }, 260);
    });
    q('braindumpCancelBtn').addEventListener('click', closeBraindump);
    function closeBraindump() {
      el.scrim.classList.remove('show');
      el.sheetBraindump.classList.remove('show');
    }
    q('braindumpSaveBtn').addEventListener('click', function () {
      var texto = q('braindumpText').value.trim();
      if (!texto) { closeBraindump(); return; }
      var titulo = texto.length > 60 ? texto.slice(0, 57) + '…' : texto;
      sb.from('p30_tasks').insert({
        user_id: state.user.id, titulo: titulo, texto_original: texto,
        tipo: 'pensamento', status: 'registrado', organizado: false, pontos: 0
      }).then(function (res) {
        if (res.error) { toast('Não consegui registrar.'); console.error(res.error); return; }
        closeBraindump();
        toast('Registrado como pensamento — não virou tarefa.');
      });
    });
  }

  // ============================================================
  // ENCERRAR O DIA (ação real: fecha o dia; a sequência guiada
  // completa do modo noturno é da Fase 3)
  // ============================================================
  function initEndDay() {
    q('endDayBtn').addEventListener('click', function () {
      sb.from('p30_daily_scores').upsert({
        user_id: state.user.id, data: state.today, pontos_total: state.score.pontos, pontos_cap: CAP,
        fechado: true, fechado_em: new Date().toISOString(),
        missoes_concluidas: state.missions.filter(function (m) { return m.done; }).length, missoes_total: state.missions.length,
        habitos_concluidos: state.habits.filter(function (h) { return h.done; }).length, habitos_total: state.habits.length
      }, { onConflict: 'user_id,data' }).then(function (res) {
        if (res.error) { toast('Não consegui encerrar o dia.'); console.error(res.error); return; }
        toast('Dia encerrado. O modo noturno completo chega na Fase 3.');
      });
    });
  }

  // ============================================================
  // AJUSTES (ciclo, rotinas, metas, conta)
  // ============================================================
  function initSettings() {
    q('settingsBtn').addEventListener('click', openSettings);
    q('settingsCloseBtn').addEventListener('click', closeSettings);
    q('signOutBtn').addEventListener('click', function () { sb.auth.signOut(); });

    function openSettings() {
      renderSettingsAccount();
      renderSettingsCycle();
      renderRoutinesAdmin();
      renderGoalsAdmin();
      el.scrim.classList.add('show');
      el.sheetSettings.classList.add('show');
    }
    function closeSettings() {
      el.scrim.classList.remove('show');
      el.sheetSettings.classList.remove('show');
    }

    function renderSettingsAccount() {
      q('accountEmail').textContent = state.user.email || '—';
    }
    function renderSettingsCycle() {
      var dayNum = Math.min(Math.max(diffDaysStr(state.cycle.data_inicio, state.today) + 1, 1), CYCLE_LENGTH_DAYS);
      q('cycleInfo').textContent = state.cycle.nome + ' — dia ' + dayNum + ' de ' + CYCLE_LENGTH_DAYS +
        ' (' + state.cycle.data_inicio + ' a ' + state.cycle.data_fim + ')';
    }
    q('newCycleBtn').addEventListener('click', function () {
      if (!window.confirm('Encerrar o ciclo atual e começar um novo de 30 dias a partir de hoje?')) return;
      sb.from('p30_cycles').update({ ativo: false }).eq('id', state.cycle.id).then(function () {
        return sb.from('p30_cycles').insert({
          user_id: state.user.id, nome: 'Novo ciclo', data_inicio: state.today,
          data_fim: addDaysStr(state.today, CYCLE_LENGTH_DAYS - 1), timezone: state.tz, ativo: true
        }).select().single();
      }).then(function (res) {
        if (res.error) { toast('Não consegui iniciar o novo ciclo.'); console.error(res.error); return; }
        state.cycle = res.data;
        renderSettingsCycle();
        renderHeader();
        toast('Novo ciclo iniciado.');
      });
    });

    // ---------- rotinas ----------
    var routineDays = [0, 1, 2, 3, 4, 5, 6];
    q('routineDayChips').innerHTML = DAY_ABBR.map(function (d, i) {
      return '<button type="button" class="chip day-chip active" data-d="' + i + '" title="' + DAY_FULL[i] + '">' + d + '</button>';
    }).join('');
    q('routineDayChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      b.classList.toggle('active');
      routineDays = Array.prototype.slice.call(q('routineDayChips').querySelectorAll('.chip.active')).map(function (x) { return +x.dataset.d; });
    });

    function renderRoutinesAdmin() {
      sb.from('p30_routines').select('*').eq('user_id', state.user.id).order('created_at', { ascending: true }).then(function (res) {
        if (res.error) { console.error(res.error); return; }
        var list = res.data || [];
        el.routinesAdminList.innerHTML = list.length ? list.map(function (r) {
          var dias = r.dias_semana.map(function (d) { return DAY_ABBR[d]; }).join('');
          return '<div class="mini-row" data-id="' + r.id + '">' +
            '<span class="mbody"><span class="mtitle">' + esc(r.titulo) + '</span>' +
            '<span class="mmeta">' + (AREA_LABEL[r.area] || 'Sem área') + ' · ' + dias + (r.horario ? ' · ' + r.horario.slice(0, 5) : '') + '</span></span>' +
            '<button class="switch' + (r.ativo ? ' on' : '') + '" data-act="toggle" aria-label="Ativar/desativar"></button>' +
            '<button class="icon-x" data-act="del" aria-label="Excluir"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>';
        }).join('') : '<div class="empty-state">Nenhuma rotina ainda.</div>';
        Array.prototype.forEach.call(el.routinesAdminList.querySelectorAll('[data-act=toggle]'), function (btn) {
          btn.addEventListener('click', function () {
            var row = btn.closest('.mini-row'); var id = row.dataset.id;
            var newOn = !btn.classList.contains('on');
            sb.from('p30_routines').update({ ativo: newOn }).eq('id', id).then(function () { renderRoutinesAdmin(); loadRoutinesToday().then(renderRoutinesToday); });
          });
        });
        Array.prototype.forEach.call(el.routinesAdminList.querySelectorAll('[data-act=del]'), function (btn) {
          btn.addEventListener('click', function () {
            var row = btn.closest('.mini-row'); var id = row.dataset.id;
            if (!window.confirm('Excluir esta rotina?')) return;
            sb.from('p30_routines').delete().eq('id', id).then(function () { renderRoutinesAdmin(); loadRoutinesToday().then(renderRoutinesToday); });
          });
        });
      });
    }
    q('addRoutineBtn').addEventListener('click', function () {
      var titulo = q('routineTitulo').value.trim();
      if (!titulo) { toast('Dê um título para a rotina.'); return; }
      if (!routineDays.length) { toast('Escolha ao menos um dia da semana.'); return; }
      var row = {
        user_id: state.user.id, titulo: titulo, area: q('routineArea').value || null,
        dias_semana: routineDays, horario: q('routineHorario').value || null,
        pontos: q('routinePontos').value ? +q('routinePontos').value : 10, ativo: true
      };
      sb.from('p30_routines').insert(row).then(function (res) {
        if (res.error) { toast('Não consegui salvar a rotina.'); console.error(res.error); return; }
        q('routineTitulo').value = ''; q('routineHorario').value = ''; q('routinePontos').value = '';
        renderRoutinesAdmin();
        loadRoutinesToday().then(function () { renderRoutinesToday(); renderScore(); });
        toast('Rotina criada.');
      });
    });

    // ---------- metas ----------
    function renderGoalsAdmin() {
      el.goalsAdminList.innerHTML = state.goals.length ? state.goals.map(function (g) {
        var prazo = g.prazo_final ? ('faltam ' + Math.max(diffDaysStr(state.today, g.prazo_final), 0) + 'd') : 'sem prazo';
        var pct = g.meta_valor ? Math.min(100, Math.round((g.progresso_atual / g.meta_valor) * 100)) : null;
        return '<div class="mini-row"><span class="mbody"><span class="mtitle">' + esc(g.titulo) + '</span>' +
          '<span class="mmeta">' + (AREA_LABEL[g.area] || 'Sem área') + ' · ' + prazo +
          (pct !== null ? '<span class="bar"><i style="width:' + pct + '%"></i></span>' : '') + '</span></span></div>';
      }).join('') : '<div class="empty-state">Nenhuma meta ativa ainda.</div>';
    }
    q('addGoalBtn').addEventListener('click', function () {
      var titulo = q('goalTitulo').value.trim();
      if (!titulo) { toast('Dê um título para a meta.'); return; }
      var row = {
        user_id: state.user.id, cycle_id: state.cycle.id, titulo: titulo, area: q('goalArea').value || null,
        prazo_final: q('goalPrazo').value || null, medida_tipo: q('goalMedidaTipo').value,
        meta_valor: q('goalMetaValor').value ? +q('goalMetaValor').value : null, status: 'ativa'
      };
      var etapaTitulo = q('goalEtapaTitulo').value.trim();
      sb.from('p30_goals').insert(row).select().single().then(function (res) {
        if (res.error) { toast('Não consegui salvar a meta.'); console.error(res.error); return; }
        var goal = res.data;
        var after = etapaTitulo
          ? sb.from('p30_goal_milestones').insert({ goal_id: goal.id, user_id: state.user.id, titulo: etapaTitulo, tipo: 'etapa_semanal', prazo: q('goalEtapaPrazo').value || null })
          : Promise.resolve();
        after.then(function () {
          q('goalTitulo').value = ''; q('goalPrazo').value = ''; q('goalMetaValor').value = ''; q('goalEtapaTitulo').value = ''; q('goalEtapaPrazo').value = '';
          loadGoals().then(function () {
            computeWeeklyMilestone(); computeDeadlineChip();
            renderGoalsAdmin(); renderWeeklyGoal(); renderInfoChips();
          });
          toast('Meta criada.');
        });
      });
    });
  }

  // ============================================================
  // navegação inferior (só "Hoje" existe nesta fase)
  // ============================================================
  function initNav() {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        if (t.dataset.tab === 'hoje') return;
        toast('Essa tela chega numa próxima fase.');
      });
    });
    q('energyGroup').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    });
    q('habitsToggle').addEventListener('click', function () { q('habitsBox').classList.toggle('open'); });
    q('routinesToggle').addEventListener('click', function () { q('routinesBox').classList.toggle('open'); });
    el.scrim.addEventListener('click', function () {
      [el.sheetCapture, el.sheetSettings, el.sheetReorganize, el.sheetBraindump].forEach(function (s) { s.classList.remove('show'); });
      el.scrim.classList.remove('show');
    });
    q('errorRetryBtn').addEventListener('click', function () {
      q('appRoot').hidden = true; q('loadingScreen').hidden = false; loadEverything();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    el.toast = q('toast');
    el.scrim = q('scrim');
    el.sheetCapture = q('sheetCapture');
    el.sheetSettings = q('sheetSettings');
    el.sheetReorganize = q('sheetReorganize');
    el.sheetBraindump = q('sheetBraindump');
    el.missionsList = q('missionsList');
    el.missionsEmpty = q('missionsEmpty');
    el.restBanner = q('restBanner');
    el.habitsList = q('habitsList');
    el.routinesBox = q('routinesBox');
    el.routinesList = q('routinesList');
    el.nextBox = q('nextBox');
    el.infoChips = q('infoChips');
    el.weeklyGoal = q('weeklyGoal');
    el.ringFg = q('ringFg');
    el.routinesAdminList = q('routinesAdminList');
    el.goalsAdminList = q('goalsAdminList');
    el.reorganizeList = q('reorganizeList');

    initAuthScreen();
    initNav();
    initCapture();
    initReorganize();
    initBraindump();
    initEndDay();
    initSettings();
    boot();
  });
})();
