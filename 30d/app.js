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
  function weekdayIdxForDateStr(dateStr) {
    var p = dateParts(dateStr);
    return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  }
  function nextDateForWeekday(targetWd) {
    var diff = (targetWd - state.weekday + 7) % 7;
    return addDaysStr(state.today, diff);
  }
  function mondayOfWeek(dateStr) {
    var wd = weekdayIdxForDateStr(dateStr);
    var offsetFromMonday = (wd + 6) % 7;
    return addDaysStr(dateStr, -offsetFromMonday);
  }
  function formatWeekRange(a, b) {
    var pa = dateParts(a), pb = dateParts(b);
    if (pa.m === pb.m) return pa.d + ' – ' + pb.d + ' de ' + MONTHS[pa.m - 1];
    return pa.d + ' de ' + MONTHS[pa.m - 1] + ' – ' + pb.d + ' de ' + MONTHS[pb.m - 1];
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
    score: { pontos: 0, cap: CAP, streak: 0 },
    weekDates: [],
    weekTasks: [],
    weekAnchor: null,
    allRoutinesCache: null
  };
  var moveTaskId = null;
  var openReorganizeRef = null;
  var reorganizeRefreshRef = null;
  var manageTask = null;
  var manageIsMission = false;

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

    var loadToken = ++loadEverything._token;
    var timedOut = false;
    var timeoutId = setTimeout(function () {
      timedOut = true;
      if (loadToken !== loadEverything._token) return;
      console.error('[30D] carregamento demorou demais (timeout de 15s)');
      showLoadError('Isso está demorando mais do que deveria. Verifique sua internet e tente de novo.');
    }, 15000);

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
        clearTimeout(timeoutId);
        if (timedOut || loadToken !== loadEverything._token) return;
        computeNextCommitment();
        computeWeeklyMilestone();
        computeDeadlineChip();
        renderAll();
        q('loadingScreen').hidden = true;
        q('appRoot').hidden = false;
        q('errorBanner').hidden = true;
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        console.error('[30D] falha ao carregar', err);
        if (timedOut || loadToken !== loadEverything._token) return;
        var msg = (err && err.message) ? err.message : 'Não consegui carregar seus dados agora.';
        showLoadError(msg);
      });
  }
  loadEverything._token = 0;

  function showLoadError(msg) {
    q('loadingScreen').hidden = true;
    q('appRoot').hidden = false;
    q('errorBanner').hidden = false;
    q('errorBannerMsg').textContent = msg;
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
    return sb.from('p30_tasks').select('*').eq('user_id', state.user.id).eq('is_missao_hoje', true).eq('missao_data', state.today)
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
    var cardsHtml = state.missions.map(function (m, i) {
      return '<div class="mission' + (m.done ? ' done' : '') + '" data-i="' + i + '">' +
        '<span class="check">' + iconCheck() + '</span>' +
        '<span class="mission-body"><span class="mission-title">' + esc(m.task.titulo) + '</span>' +
        '<span class="mission-meta">' + (AREA_LABEL[m.task.area] || 'Sem área') + '</span></span>' +
        '<span class="mission-pts">' + (m.done ? 'Concluída' : '+' + m.task.pontos) + '</span>' +
        '<button class="mission-more" data-more-i="' + i + '" type="button" aria-label="Opções">&#8942;</button>' +
        '</div>';
    }).join('');
    var addRow = state.missions.length < 3 ? '<button class="add-mission-row" id="addMissionRow" type="button">+ Adicionar missão</button>' : '';
    wrap.innerHTML = cardsHtml + addRow;
    Array.prototype.forEach.call(wrap.querySelectorAll('.mission'), function (node) {
      node.addEventListener('click', function (e) {
        if (e.target.closest('.mission-more')) return;
        toggleMission(+node.dataset.i);
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.mission-more'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openTaskManage(state.missions[+btn.dataset.moreI].task, { isMission: true });
      });
    });
    var addBtn = q('addMissionRow');
    if (addBtn) addBtn.addEventListener('click', function () { openReorganizeRef && openReorganizeRef(); });
    var allDone = state.missions.every(function (m) { return m.done; });
    el.restBanner.classList.toggle('show', allDone);
  }

  function toggleMission(i) {
    var m = state.missions[i];
    var prevDone = m.done, prevStatus = m.task.status;
    m.done = !m.done;
    var newStatus = m.done ? 'concluida' : 'pendente';
    m.task.status = newStatus;
    renderMissions();
    persistDailyScore();
    sb.from('p30_tasks').update({ status: newStatus, concluido_em: m.done ? new Date().toISOString() : null })
      .eq('id', m.task.id).then(function (res) {
        if (res.error) {
          console.error(res.error);
          m.done = prevDone; m.task.status = prevStatus;
          renderMissions();
          persistDailyScore();
          toast('Não consegui salvar. Tente de novo.');
        }
      });
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
    var selectedWhen = 'hoje';
    var currentTaskId = null;
    var days2 = [0, 1, 2, 3, 4, 5, 6];

    function resolveWhenToDate(when) {
      if (when === 'hoje') return state.today;
      if (when === 'amanha') return addDaysStr(state.today, 1);
      return nextDateForWeekday(+when);
    }

    q('areaChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x === b); });
      selectedArea = b.dataset.a;
    });
    q('whenChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x === b); });
      selectedWhen = b.dataset.when;
      if (stage2Open) q('capPrazo').value = resolveWhenToDate(selectedWhen);
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
      selectedArea = null; selectedTipo = 'tarefa'; selectedPrioridade = null; selectedWhen = 'hoje'; currentTaskId = null;
      Array.prototype.forEach.call(q('areaChips').querySelectorAll('.chip'), function (x) { x.classList.remove('active'); });
      Array.prototype.forEach.call(q('whenChips').querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x.dataset.when === 'hoje'); });
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
      if (!q('capPrazo').value) q('capPrazo').value = resolveWhenToDate(selectedWhen);
    });

    q('saveCaptureBtn').addEventListener('click', function () {
      var titulo = q('captureInput').value.trim();
      if (!titulo) { toast('Escreva algo antes de salvar.'); return; }
      var row = {
        user_id: state.user.id, titulo: titulo, texto_original: titulo,
        area: selectedArea, tipo: 'tarefa', status: 'pendente', organizado: false, pontos: 10,
        data: resolveWhenToDate(selectedWhen)
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
    var lastTasks = [];
    q('reorganizeBtn').addEventListener('click', openReorganize);
    q('missionsEmptyReorganizeBtn').addEventListener('click', openReorganize);
    openReorganizeRef = openReorganize;

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
          lastTasks = res.data || [];
          renderReorganizeList(lastTasks);
          el.scrim.classList.add('show');
          el.sheetReorganize.classList.add('show');
        });
    }
    reorganizeRefreshRef = function () {
      if (el.sheetReorganize.classList.contains('show')) openReorganize();
    };
    function closeReorganize() {
      el.scrim.classList.remove('show');
      el.sheetReorganize.classList.remove('show');
    }
    q('reorganizeCancelBtn').addEventListener('click', closeReorganize);

    function renderReorganizeList(tasks) {
      el.reorganizeList.innerHTML = tasks.length ? tasks.map(function (t) {
        return '<div class="mini-row" data-row-id="' + t.id + '" style="cursor:pointer;">' +
          '<input type="checkbox" data-id="' + t.id + '"' + (selected[t.id] ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:#c3a35f;flex:0 0 auto;">' +
          '<span class="mbody"><span class="mtitle">' + esc(t.titulo) + '</span>' +
          '<span class="mmeta">' + (AREA_LABEL[t.area] || 'Sem área') + '</span></span>' +
          '<button class="reorg-more-btn" data-reorg-more="' + t.id + '" type="button" aria-label="Opções">&#8942;</button></div>';
      }).join('') : '<div class="empty-state">Nada pendente pra organizar agora. Use a captura pra adicionar algo.</div>';
      Array.prototype.forEach.call(el.reorganizeList.querySelectorAll('.mini-row'), function (row) {
        row.addEventListener('click', function (e) {
          if (e.target.closest('.reorg-more-btn')) return;
          var cb = row.querySelector('input[type=checkbox]');
          if (e.target !== cb) cb.checked = !cb.checked;
          var checkedCount = Object.keys(selected).filter(function (k) { return selected[k]; }).length;
          if (cb.checked && checkedCount >= 3 && !selected[cb.dataset.id]) { cb.checked = false; toast('No máximo 3 missões por vez.'); return; }
          selected[cb.dataset.id] = cb.checked;
        });
      });
      Array.prototype.forEach.call(el.reorganizeList.querySelectorAll('[data-reorg-more]'), function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var task = tasks.filter(function (t) { return t.id === btn.dataset.reorgMore; })[0];
          if (task) openTaskManage(task, { isMission: !!selected[task.id] });
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
        ops.push(sb.from('p30_tasks').update({ is_missao_hoje: true, missao_data: state.today, status: 'pendente' }).eq('id', id).eq('status', 'inbox'));
        ops.push(sb.from('p30_tasks').update({ is_missao_hoje: true, missao_data: state.today }).eq('id', id).neq('status', 'inbox'));
      });
      toUnset.forEach(function (id) { ops.push(sb.from('p30_tasks').update({ is_missao_hoje: false, missao_data: null }).eq('id', id)); });
      Promise.all(ops).then(function () {
        q('reorganizeSaveBtn').disabled = false;
        closeReorganize();
        toast('Seu dia foi reorganizado.');
        loadMissions().then(function () { renderMissions(); persistDailyScore(); computeNextCommitment(); renderNext(); });
      });
    });
  }

  // ============================================================
  // GERENCIAR TAREFA/MISSÃO — sheet único reaproveitado a partir do
  // card de missão (Hoje), da linha de tarefa (Semana) e da lista de
  // "Reorganizar meu dia". Editar/adiar/remover-da-missão/excluir só
  // atualizam a tela DEPOIS da confirmação do servidor — nunca otimista
  // aqui, então uma falha nunca deixa a tela "mentindo" sobre algo que
  // não foi salvo de verdade.
  // ============================================================
  function openTaskManage(task, opts) {
    manageTask = task;
    manageIsMission = !!(opts && opts.isMission);
    q('tmTitleLabel').textContent = 'Gerenciar tarefa';
    q('tmTitulo').value = task.titulo || '';
    q('tmData').value = task.data || '';
    q('tmHorario').value = task.horario ? task.horario.slice(0, 5) : '';
    q('tmProximaAcao').value = task.proxima_acao || '';
    q('tmPontos').value = task.pontos != null ? task.pontos : 10;
    Array.prototype.forEach.call(q('tmAreaChips').querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x.dataset.a === task.area); });
    Array.prototype.forEach.call(q('tmPrioridadeChips').querySelectorAll('.chip'), function (x) { x.classList.toggle('active', x.dataset.p === task.prioridade); });
    q('tmConcluirBtn').textContent = task.status === 'concluida' ? 'Desmarcar conclusão' : 'Concluir';
    q('tmRemoverMissaoBtn').hidden = !manageIsMission;
    el.scrim.classList.add('show');
    el.sheetTaskManage.classList.add('show');
  }
  function closeTaskManage() {
    el.scrim.classList.remove('show');
    el.sheetTaskManage.classList.remove('show');
    manageTask = null;
  }
  function refreshAfterTaskChange() {
    loadMissions().then(function () {
      renderMissions();
      persistDailyScore();
      computeNextCommitment();
      renderNext();
    });
    if (!q('viewSemana').hidden) reloadWeek();
    if (reorganizeRefreshRef) reorganizeRefreshRef();
  }
  function initTaskManage() {
    q('tmCloseBtn').addEventListener('click', closeTaskManage);
    q('tmAreaChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      var already = b.classList.contains('active');
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.remove('active'); });
      if (!already) b.classList.add('active');
    });
    q('tmPrioridadeChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      var already = b.classList.contains('active');
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.remove('active'); });
      if (!already) b.classList.add('active');
    });

    function runAction(btn, promiseFn, successMsg) {
      if (btn.disabled) return;
      btn.disabled = true;
      promiseFn().then(function (res) {
        btn.disabled = false;
        if (res && res.error) {
          console.error(res.error);
          toast('Não consegui salvar. Tente de novo.');
          return;
        }
        toast(successMsg);
        closeTaskManage();
        refreshAfterTaskChange();
      });
    }

    q('tmSaveBtn').addEventListener('click', function () {
      if (!manageTask) return;
      var titulo = q('tmTitulo').value.trim();
      if (!titulo) { toast('O título não pode ficar vazio.'); return; }
      var areaChip = q('tmAreaChips').querySelector('.chip.active');
      var prioChip = q('tmPrioridadeChips').querySelector('.chip.active');
      var patch = {
        titulo: titulo, area: areaChip ? areaChip.dataset.a : null,
        data: q('tmData').value || null, horario: q('tmHorario').value || null,
        prioridade: prioChip ? prioChip.dataset.p : null,
        proxima_acao: q('tmProximaAcao').value.trim() || null,
        pontos: q('tmPontos').value !== '' ? +q('tmPontos').value : 10
      };
      runAction(q('tmSaveBtn'), function () { return sb.from('p30_tasks').update(patch).eq('id', manageTask.id); }, 'Alterações salvas.');
    });

    q('tmConcluirBtn').addEventListener('click', function () {
      if (!manageTask) return;
      var novoStatus = manageTask.status === 'concluida' ? 'pendente' : 'concluida';
      runAction(q('tmConcluirBtn'), function () {
        return sb.from('p30_tasks').update({ status: novoStatus, concluido_em: novoStatus === 'concluida' ? new Date().toISOString() : null }).eq('id', manageTask.id);
      }, novoStatus === 'concluida' ? 'Concluída.' : 'Conclusão desfeita.');
    });

    q('tmAdiarBtn').addEventListener('click', function () {
      if (!manageTask) return;
      runAction(q('tmAdiarBtn'), function () {
        return sb.from('p30_tasks').update({ status: 'adiada', is_missao_hoje: false, missao_data: null, data: null }).eq('id', manageTask.id);
      }, 'Adiada — sem data, fica no backlog até você decidir.');
    });

    q('tmRemoverMissaoBtn').addEventListener('click', function () {
      if (!manageTask) return;
      runAction(q('tmRemoverMissaoBtn'), function () {
        return sb.from('p30_tasks').update({ is_missao_hoje: false, missao_data: null }).eq('id', manageTask.id);
      }, 'Removida das missões de hoje — a tarefa continua existindo.');
    });

    q('tmDeleteBtn').addEventListener('click', function () {
      if (!manageTask) return;
      if (!window.confirm('Excluir esta tarefa definitivamente? Não tem como desfazer.')) return;
      runAction(q('tmDeleteBtn'), function () { return sb.from('p30_tasks').delete().eq('id', manageTask.id); }, 'Tarefa excluída.');
    });
  }

  // ============================================================
  // MINHA SEMANA — visão de segunda a domingo. Mostra tarefas com
  // "data" marcada dentro da semana + rotinas do dia da semana
  // correspondente (rotinas aqui são só informativas; concluir uma
  // rotina continua sendo feito na tela Hoje).
  // ============================================================
  function loadWeek() {
    var monday = mondayOfWeek(state.weekAnchor || state.today);
    var sunday = addDaysStr(monday, 6);
    state.weekDates = [];
    for (var i = 0; i < 7; i++) state.weekDates.push(addDaysStr(monday, i));
    var pTasks = sb.from('p30_tasks').select('*').eq('user_id', state.user.id)
      .in('tipo', ['tarefa', 'aguardando']).not('status', 'in', '(concluida,arquivada)')
      .gte('data', monday).lte('data', sunday);
    var pRoutines = state.allRoutinesCache
      ? Promise.resolve({ data: state.allRoutinesCache, error: null })
      : sb.from('p30_routines').select('*').eq('user_id', state.user.id).eq('ativo', true);
    return Promise.all([pTasks, pRoutines]).then(function (results) {
      if (results[0].error) throw results[0].error;
      if (results[1].error) throw results[1].error;
      state.weekTasks = results[0].data || [];
      state.allRoutinesCache = results[1].data || [];
    });
  }

  function renderWeek() {
    q('weekRangeLabel').textContent = formatWeekRange(state.weekDates[0], state.weekDates[6]);
    var html = state.weekDates.map(function (d) {
      var wd = weekdayIdxForDateStr(d);
      var isToday = d === state.today;
      var dayTasks = state.weekTasks.filter(function (t) { return t.data === d; });
      var dayRoutines = state.allRoutinesCache.filter(function (r) { return r.dias_semana && r.dias_semana.indexOf(wd) !== -1; });
      var body;
      if (!dayTasks.length && !dayRoutines.length) {
        body = '<div class="week-empty">Nada planejado</div>';
      } else {
        body = dayRoutines.map(function (r) {
          return '<div class="week-task-row routine"><span class="dot"></span><span class="t">' + esc(r.titulo) + '</span></div>';
        }).join('') + dayTasks.map(function (t) {
          return '<div class="week-task-row' + (t.status === 'concluida' ? ' done' : '') + '" data-id="' + t.id + '">' +
            '<span class="check" data-check="' + t.id + '">' + iconCheck() + '</span>' +
            '<span class="t">' + esc(t.titulo) + (t.horario ? ' <span class=\'week-task-time\'>' + t.horario.slice(0, 5) + '</span>' : '') + '</span>' +
            '<button class="week-move-btn" data-move="' + t.id + '" type="button">&#8594;</button>' +
            '<button class="week-more-btn" data-week-more="' + t.id + '" type="button" aria-label="Opções">&#8942;</button></div>';
        }).join('');
      }
      return '<div class="week-day' + (isToday ? ' today' : '') + '">' +
        '<div class="week-day-head"><span class="week-day-name">' + DAY_FULL[wd].split('-')[0].toUpperCase() + '</span>' +
        '<span class="week-day-date">' + (+d.split('-')[2]) + '</span></div>' + body +
        '<div class="week-add-row">' +
        '<input type="text" class="week-add-input" data-day="' + d + '" placeholder="Escrever tarefa...">' +
        '<input type="time" class="week-add-time" data-day="' + d + '">' +
        '<button class="week-add-btn" data-day="' + d + '" type="button" aria-label="Adicionar">+</button>' +
        '</div></div>';
    }).join('');
    q('weekDays').innerHTML = html;
    Array.prototype.forEach.call(q('weekDays').querySelectorAll('[data-check]'), function (chk) {
      chk.addEventListener('click', function () { toggleWeekTask(chk.dataset.check); });
    });
    Array.prototype.forEach.call(q('weekDays').querySelectorAll('.week-add-btn'), function (btn) {
      btn.addEventListener('click', function () { submitWeekAdd(btn.dataset.day); });
    });
    Array.prototype.forEach.call(q('weekDays').querySelectorAll('.week-add-input'), function (input) {
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitWeekAdd(input.dataset.day); });
    });
    Array.prototype.forEach.call(q('weekDays').querySelectorAll('[data-week-more]'), function (btn) {
      btn.addEventListener('click', function () {
        var t = state.weekTasks.find(function (x) { return x.id === btn.dataset.weekMore; });
        if (t) openTaskManage(t, { isMission: !!(t.is_missao_hoje && t.missao_data === state.today) });
      });
    });
    Array.prototype.forEach.call(q('weekDays').querySelectorAll('[data-move]'), function (btn) {
      btn.addEventListener('click', function () { openMoveSheet(btn.dataset.move); });
    });
  }

  function submitWeekAdd(dateStr) {
    var input = q('weekDays').querySelector('.week-add-input[data-day="' + dateStr + '"]');
    var timeInput = q('weekDays').querySelector('.week-add-time[data-day="' + dateStr + '"]');
    var titulo = input.value.trim();
    if (!titulo) { toast('Escreva algo antes de adicionar.'); return; }
    var row = {
      user_id: state.user.id, cycle_id: state.cycle.id, titulo: titulo, texto_original: titulo,
      tipo: 'tarefa', status: 'pendente', organizado: true, data: dateStr, horario: timeInput.value || null, pontos: 10
    };
    input.disabled = true;
    sb.from('p30_tasks').insert(row).then(function (res) {
      input.disabled = false;
      if (res.error) { toast('Não consegui salvar.'); console.error(res.error); return; }
      toast('Adicionada.');
      loadWeek().then(renderWeek);
      if (dateStr === state.today) { loadMissions().then(renderMissions); computeNextCommitment(); renderNext(); }
    });
  }

  function toggleWeekTask(id) {
    var t = state.weekTasks.find(function (x) { return x.id === id; });
    if (!t) return;
    var newStatus = t.status === 'concluida' ? 'pendente' : 'concluida';
    t.status = newStatus;
    sb.from('p30_tasks').update({ status: newStatus, concluido_em: newStatus === 'concluida' ? new Date().toISOString() : null })
      .eq('id', id).then(function (res) { if (res.error) console.error(res.error); });
    renderWeek();
  }

  function openMoveSheet(taskId) {
    moveTaskId = taskId;
    q('moveDayChips').innerHTML = state.weekDates.map(function (d) {
      var wd = weekdayIdxForDateStr(d);
      var isToday = d === state.today;
      return '<button type="button" class="chip' + (isToday ? ' active' : '') + '" data-date="' + d + '">' + DAY_ABBR[wd] + ' ' + (+d.split('-')[2]) + '</button>';
    }).join('');
    Array.prototype.forEach.call(q('moveDayChips').querySelectorAll('.chip'), function (b) {
      b.addEventListener('click', function () { moveTaskTo(b.dataset.date); });
    });
    el.scrim.classList.add('show');
    el.sheetMoveTask.classList.add('show');
  }
  function closeMoveSheet() {
    el.scrim.classList.remove('show');
    el.sheetMoveTask.classList.remove('show');
  }
  function moveTaskTo(dateStr) {
    var t = state.weekTasks.find(function (x) { return x.id === moveTaskId; });
    if (t) t.data = dateStr;
    sb.from('p30_tasks').update({ data: dateStr }).eq('id', moveTaskId)
      .then(function (res) { if (res.error) console.error(res.error); });
    closeMoveSheet();
    renderWeek();
    toast('Tarefa movida.');
  }
  function reloadWeek() {
    q('weekRangeLabel').textContent = 'Carregando…';
    loadWeek().then(renderWeek).catch(function (err) {
      console.error('[30D] falha ao carregar semana', err);
      toast('Não consegui carregar a semana.');
    });
  }
  function initWeek() {
    q('moveCancelBtn').addEventListener('click', closeMoveSheet);
    q('weekPrevBtn').addEventListener('click', function () {
      state.weekAnchor = addDaysStr(mondayOfWeek(state.weekAnchor || state.today), -7);
      reloadWeek();
    });
    q('weekNextBtn').addEventListener('click', function () {
      state.weekAnchor = addDaysStr(mondayOfWeek(state.weekAnchor || state.today), 7);
      reloadWeek();
    });
    q('weekTodayBtn').addEventListener('click', function () {
      state.weekAnchor = state.today;
      reloadWeek();
    });
  }

  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    q('viewHoje').hidden = tab !== 'hoje';
    q('viewSemana').hidden = tab !== 'semana';
    if (tab === 'semana') {
      if (!state.weekAnchor) state.weekAnchor = state.today;
      reloadWeek();
    }
  }

  // ============================================================
  // PAINEL DETALHADO DA META (PR 2 — TCC e futuras metas). Progresso
  // calculado pelo PESO das etapas concluídas, não pela contagem.
  // Cada mudança de conclusão grava uma linha em p30_goal_progress_log
  // (percentual antes/depois) — é isso que alimenta o histórico e o
  // "gráfico" simples (barras, sem biblioteca).
  // ============================================================
  var gdState = { goal: null, milestones: [], sessionsCount: 0, history: [] };

  function formatDatePt(dateStr) {
    var p = dateParts(dateStr);
    return (p.d < 10 ? '0' : '') + p.d + '/' + (p.m < 10 ? '0' : '') + p.m;
  }

  function computeWeightedProgress(milestones) {
    var marcos = milestones.filter(function (m) { return m.tipo === 'marco'; });
    var withWeight = marcos.filter(function (m) { return m.peso != null; });
    if (withWeight.length) {
      var totalWeight = withWeight.reduce(function (s, m) { return s + Number(m.peso); }, 0);
      var doneWeight = withWeight.filter(function (m) { return m.concluido; }).reduce(function (s, m) { return s + Number(m.peso); }, 0);
      return totalWeight > 0 ? Math.round((doneWeight / totalWeight) * 100) : 0;
    }
    if (!marcos.length) return 0;
    var done = marcos.filter(function (m) { return m.concluido; }).length;
    return Math.round((done / marcos.length) * 100);
  }

  function loadGoalDetail(goalId) {
    var pGoal = sb.from('p30_goals').select('*').eq('id', goalId).single();
    var pMilestones = sb.from('p30_goal_milestones').select('*').eq('goal_id', goalId).order('ordem', { ascending: true });
    var pSessions = sb.from('p30_tasks').select('id,duracao_min').eq('goal_id', goalId).eq('status', 'concluida');
    var pHistory = sb.from('p30_goal_progress_log').select('*').eq('goal_id', goalId).order('created_at', { ascending: false }).limit(10);
    return Promise.all([pGoal, pMilestones, pSessions, pHistory]).then(function (r) {
      if (r[0].error) throw r[0].error;
      if (r[1].error) throw r[1].error;
      if (r[2].error) throw r[2].error;
      if (r[3].error) throw r[3].error;
      gdState.goal = r[0].data;
      gdState.milestones = r[1].data || [];
      gdState.sessionsCount = (r[2].data || []).filter(function (t) { return t.duracao_min != null; }).length;
      gdState.history = r[3].data || [];
    });
  }

  function openGoalDetail(goalId) {
    loadGoalDetail(goalId).then(function () {
      renderGoalDetail();
      el.scrim.classList.add('show');
      el.sheetGoalDetail.classList.add('show');
    }).catch(function (err) {
      console.error('[30D] falha ao carregar painel da meta', err);
      toast('Não consegui carregar a meta.');
    });
  }
  function closeGoalDetail() {
    el.scrim.classList.remove('show');
    el.sheetGoalDetail.classList.remove('show');
  }

  function renderGoalDetail() {
    var g = gdState.goal;
    q('gdTitulo').textContent = g.titulo;
    if (g.prazo_final) {
      var dias = diffDaysStr(state.today, g.prazo_final);
      q('gdSubinfo').textContent = 'Prazo: ' + formatDatePt(g.prazo_final) + (dias >= 0 ? ' · faltam ' + dias + ' dias' : ' · atrasada há ' + (-dias) + ' dias');
    } else {
      q('gdSubinfo').textContent = 'Sem prazo definido';
    }
    var pct = computeWeightedProgress(gdState.milestones);
    q('gdProgressFill').style.width = pct + '%';
    q('gdProgressLabel').textContent = pct + '%';

    var marcos = gdState.milestones.filter(function (m) { return m.tipo === 'marco'; });
    var withWeight = marcos.filter(function (m) { return m.peso != null; });
    var totalWeight = withWeight.reduce(function (s, m) { return s + Number(m.peso); }, 0);
    if (withWeight.length && withWeight.length < marcos.length) {
      q('gdWeightWarn').hidden = false;
      q('gdWeightWarn').textContent = (marcos.length - withWeight.length) + ' etapa(s) ainda sem peso — o progresso considera só as que já têm peso definido.';
    } else if (withWeight.length && Math.round(totalWeight) !== 100) {
      q('gdWeightWarn').hidden = false;
      q('gdWeightWarn').textContent = 'Soma dos pesos: ' + Math.round(totalWeight) + '% (o ideal é fechar 100%).';
    } else {
      q('gdWeightWarn').hidden = true;
    }

    var marcosOrdenados = marcos.slice().sort(function (a, b) { return (a.ordem || 0) - (b.ordem || 0); });
    var etapaAtual = marcosOrdenados.filter(function (m) { return !m.concluido; })[0];
    q('gdEtapaAtual').textContent = etapaAtual ? etapaAtual.titulo : (marcosOrdenados.length ? 'Todas as etapas concluídas' : 'Nenhuma etapa cadastrada ainda');

    var etapaSemana = gdState.milestones.filter(function (m) { return m.tipo === 'etapa_semanal' && !m.concluido; })
      .sort(function (a, b) { return (a.prazo || '9999') < (b.prazo || '9999') ? -1 : 1; })[0];
    q('gdMetaSemana').textContent = etapaSemana ? etapaSemana.titulo : 'Nenhuma meta da semana definida ainda';
    q('gdProximaAcaoSemana').textContent = etapaSemana && etapaSemana.proxima_acao ? ('Próxima ação: ' + etapaSemana.proxima_acao) : '';

    q('gdSessoesCount').textContent = gdState.sessionsCount + (gdState.sessionsCount === 1 ? ' sessão registrada' : ' sessões registradas');

    q('gdHistory').innerHTML = gdState.history.length ? gdState.history.map(function (h) {
      var v = Math.round(h.percentual_novo || 0);
      return '<div class="gd-history-row"><span>' + formatDatePt(h.data) + '</span>' +
        '<span class="bar"><i style="width:' + v + '%"></i></span>' +
        '<span class="pct">' + v + '%</span></div>';
    }).join('') : '<p class="sub" style="margin:0;">Ainda sem histórico — aparece aqui a cada etapa concluída.</p>';

    renderGoalMilestonesList(marcosOrdenados);
  }

  function renderGoalMilestonesList(marcosOrdenados) {
    q('gdMilestones').innerHTML = marcosOrdenados.length ? marcosOrdenados.map(function (m, i) {
      return '<div class="gd-milestone' + (m.concluido ? ' done' : '') + '">' +
        '<div class="gd-milestone-row">' +
        '<button class="gd-check" data-check-m="' + m.id + '" type="button">' + iconCheck() + '</button>' +
        '<span class="gd-mtitle">' + esc(m.titulo) + (m.peso != null ? '<span class="gd-mpeso">' + m.peso + '%</span>' : '') + '</span>' +
        '<button class="gd-reorder" data-up="' + m.id + '" type="button"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
        '<button class="gd-reorder" data-down="' + m.id + '" type="button"' + (i === marcosOrdenados.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
        '<button class="gd-edit-toggle" data-editm="' + m.id + '" type="button">&#9998;</button>' +
        '</div>' +
        '<div class="gd-milestone-edit" id="gdEditRow-' + m.id + '" hidden>' +
        '<label>Título</label><input type="text" class="gd-e-titulo" value="' + esc(m.titulo).replace(/"/g, '&quot;') + '">' +
        '<div class="field-row2">' +
        '<div><label>Peso (%)</label><input type="number" class="gd-e-peso" min="0" max="100" value="' + (m.peso != null ? m.peso : '') + '"></div>' +
        '<div><label>Prazo</label><input type="date" class="gd-e-prazo" value="' + (m.prazo || '') + '"></div>' +
        '</div>' +
        '<label>Próxima ação</label><input type="text" class="gd-e-proxima" value="' + esc(m.proxima_acao || '').replace(/"/g, '&quot;') + '">' +
        '<label>Observação</label><textarea class="gd-e-obs">' + esc(m.observacao || '') + '</textarea>' +
        '<div class="actions-row">' +
        '<button class="btn ghost small" data-remove-m="' + m.id + '" type="button">Remover etapa</button>' +
        '<button class="btn primary small" data-save-m="' + m.id + '" type="button">Salvar</button>' +
        '</div></div></div>';
    }).join('') : '<p class="sub" style="margin:0;">Nenhuma etapa cadastrada ainda.</p>';

    Array.prototype.forEach.call(q('gdMilestones').querySelectorAll('[data-check-m]'), function (btn) {
      btn.addEventListener('click', function () { toggleMilestoneDone(btn.dataset.checkM); });
    });
    Array.prototype.forEach.call(q('gdMilestones').querySelectorAll('[data-editm]'), function (btn) {
      btn.addEventListener('click', function () {
        var row = document.getElementById('gdEditRow-' + btn.dataset.editm);
        if (row) row.hidden = !row.hidden;
      });
    });
    Array.prototype.forEach.call(q('gdMilestones').querySelectorAll('[data-up]'), function (btn) {
      btn.addEventListener('click', function () { if (!btn.disabled) reorderMilestone(btn.dataset.up, -1); });
    });
    Array.prototype.forEach.call(q('gdMilestones').querySelectorAll('[data-down]'), function (btn) {
      btn.addEventListener('click', function () { if (!btn.disabled) reorderMilestone(btn.dataset.down, 1); });
    });
    Array.prototype.forEach.call(q('gdMilestones').querySelectorAll('[data-save-m]'), function (btn) {
      btn.addEventListener('click', function () { saveMilestoneEdit(btn.dataset.saveM); });
    });
    Array.prototype.forEach.call(q('gdMilestones').querySelectorAll('[data-remove-m]'), function (btn) {
      btn.addEventListener('click', function () { removeMilestone(btn.dataset.removeM); });
    });
  }

  function syncWeeklyWidgetsAfterGoalChange() {
    loadGoals().then(function () { computeWeeklyMilestone(); computeDeadlineChip(); renderWeeklyGoal(); renderInfoChips(); });
  }

  function toggleMilestoneDone(id) {
    var m = gdState.milestones.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    var prevPct = computeWeightedProgress(gdState.milestones);
    var novoConcluido = !m.concluido;
    var simulated = gdState.milestones.map(function (x) { return x.id === id ? Object.assign({}, x, { concluido: novoConcluido }) : x; });
    var newPct = computeWeightedProgress(simulated);
    var patch = { concluido: novoConcluido, data_conclusao: novoConcluido ? state.today : null };
    sb.from('p30_goal_milestones').update(patch).eq('id', id).then(function (res) {
      if (res.error) throw res.error;
      return sb.from('p30_goal_progress_log').insert({
        user_id: state.user.id, goal_id: gdState.goal.id, milestone_id: id, data: state.today,
        percentual_anterior: prevPct, percentual_novo: newPct
      });
    }).then(function (res2) {
      if (res2 && res2.error) throw res2.error;
      loadGoalDetail(gdState.goal.id).then(renderGoalDetail);
      syncWeeklyWidgetsAfterGoalChange();
    }).catch(function (err) {
      console.error(err);
      toast('Não consegui salvar. Tente de novo.');
    });
  }

  function reorderMilestone(id, dir) {
    var marcos = gdState.milestones.filter(function (m) { return m.tipo === 'marco'; }).sort(function (a, b) { return (a.ordem || 0) - (b.ordem || 0); });
    var idx = marcos.findIndex(function (m) { return m.id === id; });
    var swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= marcos.length) return;
    var a = marcos[idx], b = marcos[swapIdx];
    var ordemA = a.ordem, ordemB = b.ordem;
    Promise.all([
      sb.from('p30_goal_milestones').update({ ordem: ordemB }).eq('id', a.id),
      sb.from('p30_goal_milestones').update({ ordem: ordemA }).eq('id', b.id)
    ]).then(function (results) {
      if (results.some(function (r) { return r.error; })) { toast('Não consegui reordenar.'); return; }
      loadGoalDetail(gdState.goal.id).then(renderGoalDetail);
    });
  }

  function saveMilestoneEdit(id) {
    var row = document.getElementById('gdEditRow-' + id);
    if (!row) return;
    var titulo = row.querySelector('.gd-e-titulo').value.trim();
    if (!titulo) { toast('O título não pode ficar vazio.'); return; }
    var pesoVal = row.querySelector('.gd-e-peso').value;
    var patch = {
      titulo: titulo, peso: pesoVal !== '' ? +pesoVal : null,
      prazo: row.querySelector('.gd-e-prazo').value || null,
      proxima_acao: row.querySelector('.gd-e-proxima').value.trim() || null,
      observacao: row.querySelector('.gd-e-obs').value.trim() || null
    };
    sb.from('p30_goal_milestones').update(patch).eq('id', id).then(function (res) {
      if (res.error) { toast('Não consegui salvar.'); console.error(res.error); return; }
      toast('Etapa atualizada.');
      loadGoalDetail(gdState.goal.id).then(renderGoalDetail);
    });
  }

  function removeMilestone(id) {
    if (!window.confirm('Remover esta etapa? O progresso é recalculado sem ela.')) return;
    sb.from('p30_goal_milestones').delete().eq('id', id).then(function (res) {
      if (res.error) { toast('Não consegui remover.'); console.error(res.error); return; }
      toast('Etapa removida.');
      loadGoalDetail(gdState.goal.id).then(renderGoalDetail);
      syncWeeklyWidgetsAfterGoalChange();
    });
  }

  function initGoalDetail() {
    q('gdCloseBtn').addEventListener('click', closeGoalDetail);
    el.weeklyGoal.addEventListener('click', function () {
      if (state.weeklyMilestone) openGoalDetail(state.weeklyMilestone.goal.id);
    });
    q('gdAddMilestoneBtn').addEventListener('click', function () {
      if (!gdState.goal) return;
      var titulo = q('gdNewTitulo').value.trim();
      if (!titulo) { toast('Dê um título pra etapa.'); return; }
      var marcos = gdState.milestones.filter(function (m) { return m.tipo === 'marco'; });
      var maxOrdem = marcos.reduce(function (mx, m) { return Math.max(mx, m.ordem || 0); }, 0);
      var row = {
        goal_id: gdState.goal.id, user_id: state.user.id, titulo: titulo, tipo: 'marco',
        peso: q('gdNewPeso').value !== '' ? +q('gdNewPeso').value : null,
        prazo: q('gdNewPrazo').value || null, ordem: maxOrdem + 1
      };
      sb.from('p30_goal_milestones').insert(row).then(function (res) {
        if (res.error) { toast('Não consegui adicionar.'); console.error(res.error); return; }
        q('gdNewTitulo').value = ''; q('gdNewPeso').value = ''; q('gdNewPrazo').value = '';
        toast('Etapa adicionada.');
        loadGoalDetail(gdState.goal.id).then(renderGoalDetail);
      });
    });
    q('gdSessaoSaveBtn').addEventListener('click', function () {
      if (!gdState.goal) return;
      var dur = q('gdSessaoDuracao').value;
      var obs = q('gdSessaoObs').value.trim();
      var titulo = 'Sessão de trabalho' + (obs ? ' — ' + obs : '');
      var row = {
        user_id: state.user.id, goal_id: gdState.goal.id, cycle_id: state.cycle.id,
        titulo: titulo, texto_original: titulo, tipo: 'tarefa', area: gdState.goal.area,
        status: 'concluida', organizado: true, data: state.today,
        duracao_min: dur !== '' ? +dur : null, concluido_em: new Date().toISOString(), pontos: 10
      };
      sb.from('p30_tasks').insert(row).then(function (res) {
        if (res.error) { toast('Não consegui registrar.'); console.error(res.error); return; }
        q('gdSessaoDuracao').value = ''; q('gdSessaoObs').value = '';
        toast('Sessão registrada.');
        loadGoalDetail(gdState.goal.id).then(renderGoalDetail);
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
        return '<div class="mini-row" data-goal-row="' + g.id + '" style="cursor:pointer;"><span class="mbody"><span class="mtitle">' + esc(g.titulo) + '</span>' +
          '<span class="mmeta">' + (AREA_LABEL[g.area] || 'Sem área') + ' · ' + prazo +
          (pct !== null ? '<span class="bar"><i style="width:' + pct + '%"></i></span>' : '') + '</span></span></div>';
      }).join('') : '<div class="empty-state">Nenhuma meta ativa ainda.</div>';
      Array.prototype.forEach.call(el.goalsAdminList.querySelectorAll('[data-goal-row]'), function (row) {
        row.addEventListener('click', function () { closeSettings(); openGoalDetail(row.dataset.goalRow); });
      });
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
  // CONFIGURAR MEU PROJETO 30D — carga inicial idempotente, em duas
  // etapas: 1) semear sugestões em p30_setup_proposals (nunca toca nas
  // tabelas reais); 2) o usuário confirma item a item, e só nesse
  // momento a linha real é criada em p30_tasks/p30_habits/p30_routines/
  // p30_goals. "categoria" controla a validação do banco; "grupo" é só
  // como a lista é seccionada na tela.
  // ============================================================
  function taskDef(slug, grupo, titulo, opts) {
    opts = opts || {};
    return {
      slug: slug, grupo: grupo, titulo: titulo, categoria: 'tarefa', dependsOn: opts.dependsOn || null,
      buildRow: function (ctx) {
        return {
          table: 'p30_tasks', row: {
            user_id: state.user.id, cycle_id: state.cycle.id, goal_id: opts.dependsOn ? ctx.goalId : null,
            titulo: titulo, texto_original: titulo, tipo: 'tarefa', area: opts.area || null, status: 'pendente', organizado: true,
            data: opts.data || null, duracao_min: opts.duracao || null,
            is_missao_hoje: !!opts.missao, missao_data: opts.missao ? opts.data : null,
            pontos: opts.missao ? 20 : 10
          }
        };
      }
    };
  }
  function routineDef(slug, titulo, dias, area) {
    return {
      slug: slug, grupo: 'Rotinas semanais', titulo: titulo, categoria: 'rotina', dependsOn: null,
      buildRow: function () {
        return { table: 'p30_routines', row: { user_id: state.user.id, titulo: titulo, area: area, dias_semana: dias, horario: null, pontos: 10, ativo: true } };
      }
    };
  }
  function habitDef(slug, titulo) {
    return {
      slug: slug, grupo: 'Hábitos essenciais', titulo: titulo, categoria: 'habito', dependsOn: null,
      buildRow: function () {
        return { table: 'p30_habits', row: { user_id: state.user.id, titulo: titulo, pontos: 8, dias_semana: null, ativo: true } };
      }
    };
  }

  var SETUP_DEFS = [
    routineDef('rotina-segunda', 'Organização do consultório', [1], 'consultorio'),
    routineDef('rotina-terca', 'Parceria clínica', [2], 'consultorio'),
    routineDef('rotina-quarta', 'Consultório particular', [3], 'consultorio'),
    routineDef('rotina-quinta', 'Parceria clínica (revisão de quarta)', [4], 'consultorio'),
    routineDef('rotina-sexta', 'Fechamento semanal', [5], 'consultorio'),
    routineDef('rotina-sabado', 'Organização pessoal', [6], 'organizacao'),
    routineDef('rotina-domingo', 'Preparação da semana', [0], 'organizacao'),

    habitDef('habito-agua', 'Beber água ao acordar'),
    habitDef('habito-sem-redes', 'Evitar redes sociais antes da rotina principal'),
    habitDef('habito-roupa-academia', 'Separar roupa da academia quando necessário'),
    habitDef('habito-alimentacao-amanha', 'Conferir alimentação do dia seguinte'),
    habitDef('habito-pausa', 'Fazer uma pausa de desaceleração (escrever, ler, orar ou respirar)'),
    habitDef('habito-celular-noite', 'Reduzir o celular à noite'),
    habitDef('habito-sem-criativos', 'Evitar tarefas criativas depois das 21h'),

    {
      slug: 'meta-tcc', grupo: 'Meta do TCC',
      titulo: 'Finalizar TCC — Previsibilidade clínica em alinhadores invisíveis',
      categoria: 'meta', dependsOn: null,
      buildRow: function () {
        return {
          table: 'p30_goals', row: {
            user_id: state.user.id, cycle_id: state.cycle.id,
            titulo: 'Finalizar TCC — Previsibilidade clínica em alinhadores invisíveis',
            area: 'futuro', prazo_final: '2026-11-30', medida_tipo: 'etapas', status: 'ativa'
          }
        };
      }
    }
  ];
  [
    'Diagnóstico do material existente', 'Organização da estrutura', 'Introdução', 'Revisão de literatura',
    'Desenvolvimento', 'Discussão', 'Conclusão', 'Referências', 'Revisão final', 'Preparação da apresentação'
  ].forEach(function (titulo, i) {
    SETUP_DEFS.push({
      slug: 'marco-tcc-' + (i + 1), grupo: 'Meta do TCC', titulo: titulo, categoria: 'marco', dependsOn: 'meta-tcc',
      buildRow: function (ctx) {
        return { table: 'p30_goal_milestones', row: { goal_id: ctx.goalId, user_id: state.user.id, titulo: titulo, tipo: 'marco', ordem: i + 1 } };
      }
    });
  });
  SETUP_DEFS.push({
    slug: 'etapa-tcc-semana1', grupo: 'Meta do TCC', titulo: 'Etapa da semana (8–16 ago): organizar o material e avançar na introdução',
    categoria: 'etapa', dependsOn: 'meta-tcc',
    buildRow: function (ctx) {
      return { table: 'p30_goal_milestones', row: { goal_id: ctx.goalId, user_id: state.user.id, titulo: 'Organizar o material e avançar na introdução', tipo: 'etapa_semanal', prazo: '2026-08-16' } };
    }
  });
  [
    'Abrir a versão atual', 'Identificar a versão mais recente', 'Listar partes incompletas', 'Revisar a estrutura',
    'Escrever a primeira parte da introdução', 'Registrar dúvidas', 'Preparar pontos para conversar com o professor'
  ].forEach(function (titulo, i) {
    SETUP_DEFS.push(taskDef('tcc-acao-' + (i + 1), 'Próximas ações do TCC', titulo, { area: 'futuro', dependsOn: 'meta-tcc' }));
  });
  SETUP_DEFS.push(taskDef('tcc-sessao-1', 'Sessões de trabalho do TCC', 'Sessão de trabalho — 45 min na introdução', { area: 'futuro', dependsOn: 'meta-tcc', duracao: 45 }));
  SETUP_DEFS.push(taskDef('tcc-sessao-2', 'Sessões de trabalho do TCC', 'Sessão de trabalho — 60 min na introdução', { area: 'futuro', dependsOn: 'meta-tcc', duracao: 60 }));

  SETUP_DEFS.push(taskDef('missao-08-08-mercado', 'Missões de hoje (8 de agosto)', 'Mercado e alimentação', { area: 'corpo', data: '2026-08-08', missao: true }));
  SETUP_DEFS.push(taskDef('missao-08-08-financeiro', 'Missões de hoje (8 de agosto)', 'Levantar entradas, saídas e boletos', { area: 'consultorio', data: '2026-08-08', missao: true }));
  SETUP_DEFS.push(taskDef('missao-08-08-tcc', 'Missões de hoje (8 de agosto)', 'Abrir e organizar o TCC', { area: 'futuro', data: '2026-08-08', missao: true, dependsOn: 'meta-tcc' }));

  [
    ['Comprar luvas', '2026-08-10'], ['Comprar contenções', '2026-08-10'], ['Comprar fios', '2026-08-10'], ['Comprar sacolas tipo chup-chup', '2026-08-10'],
    ['Resolver os trabalhos protéticos', null], ['Verificar possibilidade de outro laboratório', null],
    ['Avaliar agenda dos pacientes do dia 12 de agosto', '2026-08-12'], ['Avaliar eventual reagendamento para 19 de agosto', '2026-08-19'],
    ['Organizar leads', null], ['Organizar ligações', null], ['Criar rotina diária da SDR', null], ['Preparar scripts', null]
  ].forEach(function (pair, i) {
    SETUP_DEFS.push(taskDef('consultorio-' + (i + 1), 'Tarefas do consultório', pair[0], { area: 'consultorio', data: pair[1] }));
  });

  [
    'Calcular entradas da primeira semana de agosto', 'Calcular saídas da primeira semana',
    'Separar tratamento vendido de valor recebido', 'Levantar contas a receber', 'Levantar boletos',
    'Calcular saldo disponível', 'Levantar despesas previstas'
  ].forEach(function (titulo, i) {
    SETUP_DEFS.push(taskDef('financeiro-' + (i + 1), 'Financeiro', titulo, { area: 'consultorio' }));
  });

  function defBySlug(slug) { return SETUP_DEFS.filter(function (d) { return d.slug === slug; })[0]; }

  function initSetup() {
    var proposalState = {};

    function seedProposals() {
      var rows = SETUP_DEFS.map(function (d) { return { user_id: state.user.id, slug: d.slug, categoria: d.categoria, titulo: d.titulo, payload: { grupo: d.grupo } }; });
      return sb.from('p30_setup_proposals').upsert(rows, { onConflict: 'user_id,slug', ignoreDuplicates: true });
    }
    function loadProposals() {
      return sb.from('p30_setup_proposals').select('*').eq('user_id', state.user.id).then(function (res) {
        if (res.error) throw res.error;
        proposalState = {};
        (res.data || []).forEach(function (p) { proposalState[p.slug] = p; });
      });
    }

    function openSetup() {
      q('setupProgress').textContent = 'Carregando sugestões…';
      q('setupGroups').innerHTML = '';
      el.sheetSettings.classList.remove('show');
      el.scrim.classList.add('show');
      el.sheetSetup.classList.add('show');
      seedProposals().then(loadProposals).then(renderSetup).catch(function (err) {
        console.error('[30D setup] falha ao carregar sugestões', err);
        toast('Não consegui carregar as sugestões.');
      });
    }
    function closeSetup() {
      el.scrim.classList.remove('show');
      el.sheetSetup.classList.remove('show');
    }

    function renderSetup() {
      var groups = {};
      var order = [];
      SETUP_DEFS.forEach(function (d) {
        if (!groups[d.grupo]) { groups[d.grupo] = []; order.push(d.grupo); }
        groups[d.grupo].push(d);
      });
      var totalConfirmed = Object.keys(proposalState).filter(function (s) { return proposalState[s].status === 'confirmado'; }).length;
      q('setupProgress').textContent = totalConfirmed + ' de ' + SETUP_DEFS.length + ' confirmadas';
      q('setupGroups').innerHTML = order.map(function (grupo, gi) {
        var defs = groups[grupo];
        var confirmedInGroup = defs.filter(function (d) { return proposalState[d.slug] && proposalState[d.slug].status === 'confirmado'; }).length;
        var itemsHtml = defs.map(function (d) {
          var p = proposalState[d.slug] || { status: 'sugerido' };
          if (p.status === 'confirmado') {
            return '<div class="setup-item confirmado"><span class="status-tag">✓</span><span class="t">' + esc(d.titulo) + '</span></div>';
          }
          var checked = p.status !== 'descartado';
          return '<div class="setup-item' + (p.status === 'descartado' ? ' descartado' : '') + '">' +
            '<input type="checkbox" data-check="' + d.slug + '"' + (checked ? ' checked' : '') + (p.status === 'descartado' ? ' disabled' : '') + '>' +
            '<span class="t">' + esc(d.titulo) + '</span>' +
            '<button class="discard-btn" data-discard="' + d.slug + '" type="button">' + (p.status === 'descartado' ? 'restaurar' : 'descartar') + '</button>' +
            '</div>';
        }).join('');
        return '<div class="setup-group' + (gi === 0 ? ' open' : '') + '">' +
          '<div class="setup-group-head"><span><span class="lab">' + esc(grupo) + '</span><span class="count">' + confirmedInGroup + '/' + defs.length + '</span></span>' +
          '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></div>' +
          '<div class="setup-group-body"><div class="setup-group-body-inner">' + itemsHtml +
          '<button class="btn primary small setup-group-confirm" data-confirm-group="' + esc(grupo) + '" type="button">Confirmar marcados</button>' +
          '</div></div></div>';
      }).join('');

      Array.prototype.forEach.call(q('setupGroups').querySelectorAll('.setup-group-head'), function (head) {
        head.addEventListener('click', function () { head.closest('.setup-group').classList.toggle('open'); });
      });
      Array.prototype.forEach.call(q('setupGroups').querySelectorAll('[data-discard]'), function (btn) {
        btn.addEventListener('click', function (e) { e.stopPropagation(); toggleDiscard(btn.dataset.discard); });
      });
      Array.prototype.forEach.call(q('setupGroups').querySelectorAll('[data-confirm-group]'), function (btn) {
        btn.addEventListener('click', function (e) { e.stopPropagation(); confirmGroup(btn.dataset.confirmGroup); });
      });
    }

    function toggleDiscard(slug) {
      var p = proposalState[slug];
      var newStatus = (p && p.status === 'descartado') ? 'sugerido' : 'descartado';
      sb.from('p30_setup_proposals').update({ status: newStatus }).eq('user_id', state.user.id).eq('slug', slug).then(function (res) {
        if (res.error) { toast('Não consegui atualizar.'); console.error(res.error); return; }
        loadProposals().then(renderSetup);
      });
    }

    function confirmOne(slug) {
      var def = defBySlug(slug);
      var p = proposalState[slug];
      if (!def || !p || p.status === 'confirmado') return Promise.resolve();
      var ctx = {};
      if (def.dependsOn) {
        var dep = proposalState[def.dependsOn];
        if (!dep || dep.status !== 'confirmado' || !dep.created_target_id) {
          toast('Confirme "' + defBySlug(def.dependsOn).titulo + '" primeiro.');
          return Promise.reject(new Error('dependency not confirmed: ' + def.dependsOn));
        }
        ctx.goalId = dep.created_target_id;
      }
      var built = def.buildRow(ctx);
      return sb.from(built.table).insert(built.row).select().single().then(function (res) {
        if (res.error) throw res.error;
        return sb.from('p30_setup_proposals').update({
          status: 'confirmado', created_target_table: built.table, created_target_id: res.data.id
        }).eq('user_id', state.user.id).eq('slug', slug);
      });
    }

    function confirmGroup(grupo) {
      var defs = SETUP_DEFS.filter(function (d) { return d.grupo === grupo; });
      var checkedSlugs = [];
      defs.forEach(function (d) {
        var p = proposalState[d.slug];
        if (p && p.status === 'confirmado') return;
        var cb = q('setupGroups').querySelector('[data-check="' + d.slug + '"]');
        if (cb && cb.checked) checkedSlugs.push(d.slug);
      });
      if (!checkedSlugs.length) { toast('Nada marcado pra confirmar neste bloco.'); return; }
      checkedSlugs.sort(function (a, b) {
        var da = defBySlug(a).dependsOn ? 1 : 0, db = defBySlug(b).dependsOn ? 1 : 0;
        return da - db;
      });
      var chain = Promise.resolve();
      checkedSlugs.forEach(function (slug) {
        chain = chain.then(function () { return confirmOne(slug); }).catch(function (err) { console.error('[30D setup]', slug, err); });
      });
      chain.then(function () {
        toast('Confirmado.');
        return loadProposals();
      }).then(function () {
        renderSetup();
        loadMissions().then(renderMissions);
        loadGoals().then(function () { computeWeeklyMilestone(); computeDeadlineChip(); renderWeeklyGoal(); renderInfoChips(); });
        loadRoutinesToday().then(function () { renderRoutinesToday(); renderScore(); });
        loadHabits().then(function () { renderHabits(); renderScore(); });
      });
    }

    function undoSetup() {
      if (!window.confirm('Remover tudo que foi criado pela carga inicial? Isso não afeta o que você criou manualmente.')) return;
      sb.from('p30_setup_proposals').select('*').eq('user_id', state.user.id).eq('status', 'confirmado').then(function (res) {
        if (res.error) { toast('Não consegui verificar a carga inicial.'); console.error(res.error); return; }
        var rows = res.data || [];
        if (!rows.length) { toast('Não há nada confirmado pra desfazer.'); return; }
        rows.sort(function (a, b) {
          var da = defBySlug(a.slug), db = defBySlug(b.slug);
          var ra = (da && da.dependsOn) ? 0 : 1, rb = (db && db.dependsOn) ? 0 : 1;
          return ra - rb;
        });
        var chain = Promise.resolve();
        rows.forEach(function (p) {
          chain = chain.then(function () {
            return sb.from(p.created_target_table).delete().eq('id', p.created_target_id).then(function () {
              return sb.from('p30_setup_proposals').update({ status: 'sugerido', created_target_id: null, created_target_table: null }).eq('id', p.id);
            });
          }).catch(function (err) { console.error('[30D setup undo]', p.slug, err); });
        });
        chain.then(function () {
          toast('Carga inicial desfeita.');
          loadEverything();
        });
      });
    }

    q('openSetupBtn').addEventListener('click', openSetup);
    q('setupCloseBtn').addEventListener('click', closeSetup);
    q('setupDoneBtn').addEventListener('click', closeSetup);
    q('undoSetupBtn').addEventListener('click', undoSetup);

    // ---------- academia: formulário direto, sem staging (o próprio
    // preenchimento já é a confirmação) ----------
    var academiaDays = [];
    q('academiaDayChips').innerHTML = DAY_ABBR.map(function (d, i) {
      return '<button type="button" class="chip day-chip" data-d="' + i + '" title="' + DAY_FULL[i] + '">' + d + '</button>';
    }).join('');
    q('academiaDayChips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      b.classList.toggle('active');
      academiaDays = Array.prototype.slice.call(q('academiaDayChips').querySelectorAll('.chip.active')).map(function (x) { return +x.dataset.d; });
    });
    q('academiaSaveBtn').addEventListener('click', function () {
      if (!academiaDays.length) { toast('Escolha ao menos um dia.'); return; }
      var row = {
        user_id: state.user.id, titulo: 'Academia', area: 'corpo', dias_semana: academiaDays.slice(),
        horario: q('academiaHorario').value || null, pontos: 20, ativo: true
      };
      q('academiaSaveBtn').disabled = true;
      sb.from('p30_routines').insert(row).then(function (res) {
        q('academiaSaveBtn').disabled = false;
        if (res.error) { toast('Não consegui salvar a rotina da academia.'); console.error(res.error); return; }
        toast('Rotina da academia confirmada.');
        Array.prototype.forEach.call(q('academiaDayChips').querySelectorAll('.chip'), function (c) { c.classList.remove('active'); });
        academiaDays = [];
        q('academiaHorario').value = ''; q('academiaDuracao').value = ''; q('academiaObs').value = '';
        loadRoutinesToday().then(function () { renderRoutinesToday(); renderScore(); });
      });
    });
  }

  // ============================================================
  // navegação inferior (só "Hoje" existe nesta fase)
  // ============================================================
  function initNav() {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var tab = t.dataset.tab;
        if (tab === 'hoje' || tab === 'semana') { switchTab(tab); return; }
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
      [el.sheetCapture, el.sheetSettings, el.sheetReorganize, el.sheetBraindump, el.sheetMoveTask, el.sheetSetup, el.sheetTaskManage, el.sheetGoalDetail].forEach(function (s) { s.classList.remove('show'); });
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
    el.sheetMoveTask = q('sheetMoveTask');
    el.sheetSetup = q('sheetSetup');
    el.sheetTaskManage = q('sheetTaskManage');
    el.sheetGoalDetail = q('sheetGoalDetail');

    initAuthScreen();
    initNav();
    initCapture();
    initReorganize();
    initTaskManage();
    initGoalDetail();
    initWeek();
    initBraindump();
    initEndDay();
    initSettings();
    initSetup();
    boot();
  });
})();
