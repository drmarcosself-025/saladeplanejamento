// Navegação e presença pessoal da interface 3.0. Não executa ações externas.
(function () {
  const $ = (id) => document.getElementById(id), P = JarvisPessoal;
  const icons = {
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    chat:'<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-8a9 9 0 1 1 18-2Z"/><path d="M7 9h8m-8 4h5"/>',
    grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    people:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 9v-3a5 5 0 0 0-2-4"/>',
    book:'<path d="M4 3h15v18H4zM8 3v18M11 8h5m-5 4h5"/>',
    wallet:'<path d="M4 6V4h15v3M3 7h18v14H3zM16 12h5v5h-5z"/>',
    mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
    wave:'<path d="M4 9v6m4-11v16m4-13v10m4-14v18m4-12v6"/>',
    volume:'<path d="M3 9v6h4l5 4V5L7 9H3m13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    settings:'<path d="m9 3-1 3-3 1v3l-2 2 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-2V7l-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
    spark:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
  };
  function iconizar(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      // Ícones são constantes locais, nunca conteúdo da IA/usuário.
      el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[el.dataset.icon] || icons.spark}</svg>`;
    });
  }
  const origins = new Map();
  for (const id of ["painelContatos", "painelVoz", "painelLeads"]) { const e = $(id), marker = document.createComment(id); e.before(marker); origins.set(id, marker); }
  document.querySelector(".presence-caption").after($("painelPendente"));
  function comando(texto) { navegar("conversa"); $("entrada").value = texto; $("barra").requestSubmit(); }
  function restaurar() { for (const [id, marker] of origins) marker.after($(id)); }
  function navegar(vista) {
    if (!["hoje", "conversa", "espacos", "pessoal", "utilidade"].includes(vista)) return;
    restaurar(); document.body.dataset.vista = vista;
    $("espacosTela").hidden = vista !== "espacos"; $("pessoalTela").hidden = vista !== "pessoal"; $("utilityTela").hidden = vista !== "utilidade";
    document.querySelectorAll(".main-nav [data-view]").forEach((b) => { b.classList.toggle("on", b.dataset.view === vista); b.setAttribute("aria-current", b.dataset.view === vista ? "page" : "false"); });
    if (vista === "pessoal") popularPerfil();
    if (vista !== "conversa") { $("crmTela").hidden = true; $("finTela").hidden = true; }
    window.scrollTo({ top: 0, behavior: "instant" });
    // O compositor mantém posição própria, sem cobrir o conteúdo no celular.
  }
  document.addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]"); if (v) navegar(v.dataset.view);
    const c = e.target.closest("[data-command]"); if (c) comando(c.dataset.command);
    const u = e.target.closest("[data-open]"); if (u) {
      const id = u.dataset.open; navegar("utilidade"); const el = $(id); $("utilityTitulo").textContent = id === "painelVoz" ? "Voz e preferências" : id === "painelLeads" ? "Cadastrar e acompanhar leads" : "Seus contatos";
      $("utilityConteudo").append(el); el.open = true;
      if (id === "painelLeads") $("leadForm").closest("details").open = true;
    }
  });
  $("utilityVoltar").addEventListener("click", () => navegar("espacos"));
  function popularPerfil() {
    const p = P.ler().perfil;
    for (const k of ["Nome", "Tom", "Foco", "Rotina", "Contexto"]) $("perfil" + k).value = p[k.toLowerCase()];
    $("perfilCompartilhar").checked = p.compartilhar;
  }
  $("perfilForm").addEventListener("submit", (e) => {
    e.preventDefault(); const d = P.ler();
    for (const k of ["Nome", "Tom", "Foco", "Rotina", "Contexto"]) d.perfil[k.toLowerCase()] = $("perfil" + k).value;
    d.perfil.compartilhar = $("perfilCompartilhar").checked;
    const ok = P.salvar(d); $("perfilStatus").textContent = ok ? "Seu contexto foi salvo neste navegador." : "Não consegui salvar neste navegador. Seus dados anteriores foram mantidos.";
    if (ok) render();
  });
  $("perfilApagar").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (!b.dataset.armado) { b.dataset.armado = "1"; b.textContent = "Toque de novo para apagar"; setTimeout(() => { delete b.dataset.armado; b.textContent = "Apagar meu contexto"; }, 5000); return; }
    const d = P.ler(); d.perfil = P.validar(null).perfil;
    const ok = P.salvar(d); $("perfilStatus").textContent = ok ? "Contexto apagado. Suas tarefas foram mantidas." : "Não consegui apagar agora.";
    delete b.dataset.armado; b.textContent = "Apagar meu contexto"; popularPerfil(); render();
  });
  function hoje() { return JarvisLeads.iso(new Date()); }
  $("tarefaForm").addEventListener("submit", (e) => {
    e.preventDefault(); const texto = $("tarefaTexto").value.trim(); if (!texto) return;
    const d = P.ler(); d.tarefas.push({ id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2,6), texto, dia: hoje(), feita: false });
    const ok = P.salvar(d); $("tarefasStatus").textContent = ok ? "Salvo neste navegador." : "Não consegui salvar a prioridade.";
    if (ok) { $("tarefaTexto").value = ""; render(); }
  });
  function node(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function render() {
    const d = P.ler(), p = d.perfil, h = new Date().getHours(), nome = p.nome.split(" ")[0] || "Marcos";
    $("saudacao").textContent = `${h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"}, ${nome}.`;
    $("hojeData").textContent = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
    $("perfilInicial").textContent = nome.slice(0,1).toUpperCase();
    $("focoTitulo").textContent = p.foco ? "Seu norte, agora." : "Mais espaço para você.";
    $("focoTexto").textContent = p.foco || "Me conte suas prioridades para tornar este espaço mais seu.";
    $("hojeFrase").textContent = p.foco ? `Hoje, um passo mais perto de: ${p.foco}` : "Vamos dar espaço ao que importa hoje.";
    const tarefas = d.tarefas.filter((t) => t.dia === hoje()), feitas = tarefas.filter((t) => t.feita).length;
    $("tarefasProgresso").textContent = `${feitas} de ${tarefas.length}`; const ul = $("tarefasLista"); ul.textContent = "";
    for (const t of tarefas) {
      const li = node("li", t.feita ? "done" : ""), label = node("label"), chk = node("input"); chk.type = "checkbox"; chk.checked = t.feita;
      chk.addEventListener("change", () => { const n = P.ler(), item = n.tarefas.find((x) => x.id === t.id); if (item) item.feita = chk.checked; if (!P.salvar(n)) $("tarefasStatus").textContent = "Não consegui salvar a alteração."; render(); });
      label.append(chk, node("span", "", t.texto)); const rm = node("button", "task-delete", "×"); rm.type = "button"; rm.setAttribute("aria-label", "Remover prioridade " + t.texto);
      rm.addEventListener("click", () => { const n = P.ler(); n.tarefas = n.tarefas.filter((x) => x.id !== t.id); if (!P.salvar(n)) $("tarefasStatus").textContent = "Não consegui remover."; render(); }); li.append(label, rm); ul.append(li);
    }
    if (!tarefas.length) ul.append(node("li", "task-empty", "O dia fica mais leve quando o próximo passo está claro."));
    const r = JarvisLeads.resumo(JarvisLeads.lista()), contas = JarvisFin.pendentes(JarvisFin.lista(), new Date(), 7), devidos = r.hoje + r.atrasados + r.semData;
    $("proximoPasso").textContent = devidos ? `${devidos} ${devidos === 1 ? "pessoa espera" : "pessoas esperam"} seu retorno.` : tarefas.some((t) => !t.feita) ? "Sua próxima prioridade está logo abaixo." : "Você tem espaço para escolher o próximo passo.";
    const pr = $("prioridades"); pr.textContent = "";
    for (const [n, label, cmd] of [[devidos, "retornos pendentes", "quem preciso retornar hoje"], [contas.length, "contas na semana", "contas a pagar"]]) {
      const b = node("button", "priority-stat"); b.type = "button"; b.dataset.command = cmd; b.append(node("strong", "", String(n)), node("span", "", label)); pr.append(b);
    }
    $("connDados").textContent = JarvisLeads.modo === "claude" && JarvisFin.modo === "claude" ? "Seu artefato Claude" : "Neste navegador";
  }
  const estados = { idle: "Por aqui, com você", ouvindo: "Estou ouvindo", pensando: "Organizando as ideias", falando: "Conversando com você" };
  new MutationObserver(() => { $("presencaEstado").textContent = estados[document.documentElement.dataset.estado] || estados.idle; }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-estado"] });
  JarvisLeads.aoMudar(render); JarvisFin.aoMudar(render);
  window.JarvisUI = { navegar, comando, iconizar, render };
  iconizar(); render(); popularPerfil(); navegar("hoje");
})();
