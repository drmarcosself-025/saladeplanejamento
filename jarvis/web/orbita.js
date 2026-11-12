// Órbita: o que antes ficava "lá embaixo" agora gira em volta do avatar.
//   - anel que MEDE o tempo: raciocinando (arco girando + segundos) e falando (progresso até o fim);
//   - atalhos ao redor (Leads, Financeiro, Contatos, Hoje, Conversar, Som) com contagem viva;
//   - medidas do dia: interações, resposta média e última (medidas na própria tela, não do servidor);
//   - controles de zoom do avatar e uma dica de gestos;
//   - a cor da interface acompanha o estado (repouso/falando âmbar, ouvindo azul, raciocinando violeta, executando verde).
// Só observa e mostra. Não executa nada além de abrir telas e focar campos já existentes.
(function () {
  const $ = (id) => document.getElementById(id);
  const centro = document.querySelector(".center"), canvas = $("avatar");
  if (!centro || !canvas) return;
  const NS = "http://www.w3.org/2000/svg";
  const PAL = { idle: [255, 175, 62], ouvindo: [56, 211, 255], pensando: [167, 115, 255], falando: [255, 145, 46], executando: [63, 233, 167] };
  const NOME = { idle: "Em repouso", ouvindo: "Ouvindo", pensando: "Raciocinando", falando: "Falando", executando: "Executando" };
  const seg = (ms) => (ms / 1000).toFixed(1).replace(".", ",") + " s";
  const reduzido = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); return e; };
  // Ícones constantes (nunca conteúdo de usuário ou da IA).
  const ICONES = {
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 9v-3a5 5 0 0 0-2-4"/>',
    wallet: '<path d="M4 6V4h15v3M3 7h18v14H3zM16 12h5v5h-5z"/>',
    book: '<path d="M4 3h15v18H4zM8 3v18M11 8h5m-5 4h5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
    chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-8a9 9 0 1 1 18-2Z"/><path d="M7 9h8m-8 4h5"/>',
    volume: '<path d="M3 9v6h4l5 4V5L7 9H3m13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    mudo: '<path d="M3 9v6h4l5 4V5L7 9H3m13 1 5 5m0-5-5 5"/>',
    mais: '<path d="M12 5v14M5 12h14"/>', menos: '<path d="M5 12h14"/>',
  };
  const icone = (nome) => { const s = sv("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }); s.innerHTML = ICONES[nome]; return s; };

  // ---------- construção ----------
  const orb = el("div", "orbita"); orb.setAttribute("role", "group"); orb.setAttribute("aria-label", "Atalhos e medições do Jarvis");
  const svg = sv("svg", { class: "orb-svg", "aria-hidden": "true" });
  const anelBase = sv("circle", { class: "orb-anel-base" }), anelProg = sv("circle", { class: "orb-anel-prog" });
  const fiosG = sv("g", { class: "orb-fios" });
  svg.append(fiosG, anelBase, anelProg);

  const pill = el("div", "orb-status"), dot = el("i", "orb-dot"), pillNome = el("b", "", NOME.idle), pillTempo = el("span", "orb-tempo", "");
  pill.setAttribute("role", "status"); pill.append(dot, pillNome, pillTempo);

  const mInter = el("b", "", "0"), mMedia = el("b", "", "—"), mUlt = el("b", "", "—");
  const metricas = el("div", "orb-metricas");
  for (const [rot, v] of [["Hoje", mInter], ["Raciocínio médio", mMedia], ["Última fala", mUlt]]) { const c = el("span", "orb-metrica"); c.append(el("small", "", rot), v); metricas.appendChild(c); }
  const interLabel = metricas.firstChild.firstChild;

  const zoomBox = el("div", "orb-zoom"), bMenos = el("button"), bMais = el("button"), zLabel = el("button", "orb-zoom-valor", "1×");
  for (const [b, n, t] of [[bMenos, "menos", "Reduzir"], [bMais, "mais", "Ampliar"]]) { b.type = "button"; b.setAttribute("aria-label", t); b.title = t; b.appendChild(icone(n)); }
  zLabel.type = "button"; zLabel.title = "Voltar ao tamanho normal"; zLabel.setAttribute("aria-label", "Voltar ao tamanho normal");
  zoomBox.append(bMenos, zLabel, bMais);
  const dica = el("p", "orb-dica", "Arraste para girar · pince ou toque duas vezes para ampliar");

  // Os atalhos NÃO repetem data-command/data-open/data-view (para não duplicar seletores da interface):
  // acionam os controles que já existem, como se você os tivesse tocado.
  const clicar = (sel) => { const e = document.querySelector(sel); if (e) e.click(); };
  const comando = (t) => { clicar('.main-nav [data-view="conversa"]'); const i = $("entrada"); if (i) { i.value = t; $("barra").requestSubmit(); } };
  const focar = (id) => setTimeout(() => { const t = $(id); if (t) { t.scrollIntoView({ block: "center", behavior: reduzido ? "auto" : "smooth" }); t.focus({ preventScroll: true }); } }, 90);
  // lado "e" (esquerda) e "d" (direita); y em fração da altura do avatar
  const SATS = [
    { id: "leads", rot: "Leads", ic: "people", lado: "e", y: 0.22, x: 8, run: () => comando("abre o CRM") },
    { id: "fin", rot: "Financeiro", ic: "wallet", lado: "e", y: 0.47, x: 3, run: () => comando("ativa o agente contador") },
    { id: "contatos", rot: "Contatos", ic: "book", lado: "e", y: 0.72, x: 8, run: () => clicar('.utility-card[data-open="painelContatos"]') },
    { id: "hoje", rot: "Prioridades", ic: "check", lado: "d", y: 0.22, x: 8, run: () => { clicar('.main-nav [data-view="hoje"]'); focar("tarefaTexto"); } },
    { id: "conversa", rot: "Conversar", ic: "chat", lado: "d", y: 0.47, x: 3, run: () => { clicar('.main-nav [data-view="conversa"]'); focar("entrada"); } },
    { id: "som", rot: "Som", ic: "volume", lado: "d", y: 0.72, x: 8, run: () => { const m = $("btnMudo"); if (m) m.click(); setTimeout(atualizarSom, 30); } },
  ];
  const sats = el("div", "orb-sats"), satEl = {};
  for (const s of SATS) {
    const b = el("button", "orb-sat lado-" + s.lado); b.type = "button"; b.dataset.sat = s.id;
    b.style.setProperty("--y", s.y); b.style.setProperty("--x", s.x + "%");
    const bolha = el("span", "orb-bolha"); bolha.appendChild(icone(s.ic));
    const badge = el("em", "orb-badge"); badge.hidden = true;
    b.append(bolha, el("span", "orb-rot", s.rot), badge); b.setAttribute("aria-label", s.rot);
    b.addEventListener("click", s.run);
    sats.appendChild(b); satEl[s.id] = { b, badge, bolha, def: s };
  }
  orb.append(svg, pill, metricas, sats, zoomBox, dica);
  centro.appendChild(orb);

  // ---------- tamanho: a órbita cobre exatamente o canvas ----------
  // Pouco espaço (celular, ou a coluna estreita da tela Conversa): os atalhos viram uma fileira
  // abaixo do avatar em vez de orbitar. A decisão usa a LARGURA REAL do avatar, não só a da janela.
  const estreito = window.matchMedia("(max-width: 760px)");
  let modoEstreito = null;
  function layout() {
    const e = estreito.matches || canvas.offsetWidth < 560;
    if (e !== modoEstreito) { modoEstreito = e; if (e) canvas.after(sats); else orb.insertBefore(sats, zoomBox); orb.classList.toggle("estreita", e); }
    sats.hidden = e && canvas.offsetHeight < 230;                     // avatar minúsculo: sem fileira
  }
  function sincronizar() {
    orb.style.left = canvas.offsetLeft + "px"; orb.style.top = canvas.offsetTop + "px";
    orb.style.width = canvas.offsetWidth + "px"; orb.style.height = canvas.offsetHeight + "px";
    orb.classList.toggle("pequena", canvas.offsetHeight < 230); layout();
  }
  new ResizeObserver(sincronizar).observe(canvas); sincronizar();
  (estreito.addEventListener ? estreito.addEventListener("change", sincronizar) : estreito.addListener(sincronizar));

  // ---------- contagens vivas ----------
  const L = window.JarvisLeads, F = window.JarvisFin;
  function setBadge(id, n, alerta) { const s = satEl[id]; if (!s) return; s.badge.hidden = !n; s.badge.textContent = String(n); s.badge.classList.toggle("alerta", !!alerta); }
  function atualizarContagens() {
    try { if (L) { const r = L.resumo(L.lista()); setBadge("leads", r.hoje + r.atrasados + r.semData, r.atrasados > 0); } } catch (_) {}
    try { if (F) setBadge("fin", F.pendentes(F.lista(), new Date(), 7).length, F.pendentes(F.lista(), new Date(), 0).some((x) => x.atrasada)); } catch (_) {}
    const tp = $("tarefasProgresso"); if (tp) { const m = tp.textContent.match(/(\d+)\s*de\s*(\d+)/); if (m) setBadge("hoje", Math.max(0, +m[2] - +m[1]), false); }
    const ct = $("contatosTitulo"); if (ct) { const m = ct.textContent.match(/\((\d+)\)/); satEl.contatos.b.title = m ? m[1] + " contatos" : "Contatos"; }
  }
  function atualizarSom() { const m = $("btnMudo"), mudo = m && m.getAttribute("aria-pressed") === "true"; const s = satEl.som; s.bolha.textContent = ""; s.bolha.appendChild(icone(mudo ? "mudo" : "volume")); s.b.classList.toggle("desligado", !!mudo); s.b.setAttribute("aria-pressed", String(!!mudo)); }
  if (L && L.aoMudar) L.aoMudar(atualizarContagens); if (F && F.aoMudar) F.aoMudar(atualizarContagens);
  for (const id of ["tarefasProgresso", "contatosTitulo"]) { const e = $(id); if (e) new MutationObserver(atualizarContagens).observe(e, { childList: true, characterData: true, subtree: true }); }
  const bm = $("btnMudo"); if (bm) new MutationObserver(atualizarSom).observe(bm, { attributes: true, attributeFilter: ["aria-pressed"] });
  atualizarContagens(); atualizarSom(); setTimeout(atualizarContagens, 800); setTimeout(atualizarContagens, 2500);

  // ---------- medidas do dia ----------
  const KEY = "jarvis_metricas_v1", hojeISO = () => (L ? L.iso(new Date()) : new Date().toISOString().slice(0, 10));
  let M = { dia: hojeISO(), n: 0, soma: 0, k: 0, fala: null };
  try { const x = JSON.parse(localStorage.getItem(KEY) || "null"); if (x && x.dia === M.dia) M = { ...M, ...x }; } catch (_) {}
  const salvarM = () => { try { localStorage.setItem(KEY, JSON.stringify(M)); } catch (_) {} };
  function pintarMetricas() {
    mInter.textContent = String(M.n); interLabel.textContent = M.n === 1 ? "Hoje · interação" : "Hoje · interações";
    mMedia.textContent = M.k ? seg(M.soma / M.k) : "—"; mUlt.textContent = M.fala == null ? "—" : seg(M.fala);
  }
  pintarMetricas();

  // ---------- estado, cor e tempo ----------
  const raiz = document.documentElement;
  let estado = raiz.dataset.estado || "idle", t0 = performance.now(), estimadoFala = 0, corAtual = PAL[estado].slice();
  function mudou(novo) {
    const agora = performance.now(), dur = agora - t0, anterior = estado;
    if (anterior === "pensando" && dur > 40) { M.soma += dur; M.k += 1; salvarM(); }
    if (anterior === "falando" && dur > 300) { M.fala = dur; salvarM(); }
    estado = PAL[novo] ? novo : "idle"; t0 = agora;
    // uma interação começa ao entrar em "raciocinando" ou, em comandos diretos, ao começar a falar
    if (estado === "pensando" || (estado === "falando" && anterior !== "pensando")) { if (M.dia !== hojeISO()) M = { dia: hojeISO(), n: 0, soma: 0, k: 0, fala: null }; M.n += 1; salvarM(); }
    if (estado === "falando") { const t = $("legendaSr"); estimadoFala = Math.max(1500, Math.min(20000, 1200 + ((t && t.textContent.length) || 60) * 55)); }
    orb.dataset.estado = estado; pill.dataset.estado = estado; pillNome.textContent = NOME[estado];
    pintarMetricas();
  }
  new MutationObserver(() => mudou(raiz.dataset.estado || "idle")).observe(raiz, { attributes: true, attributeFilter: ["data-estado"] });
  orb.dataset.estado = estado;

  // ---------- zoom e gestos ----------
  const av = () => window.JarvisAvatar && window.JarvisAvatar.principal;
  bMais.addEventListener("click", () => { const a = av(); if (a && a.zoomEm) a.zoomEm(a.zoom * 1.3); });
  bMenos.addEventListener("click", () => { const a = av(); if (a && a.zoomEm) a.zoomEm(a.zoom / 1.3); });
  zLabel.addEventListener("click", () => { const a = av(); if (a && a.resetar) a.resetar(); });
  let dicaVista = 0; try { dicaVista = +localStorage.getItem("jarvis_dica_avatar") || 0; } catch (_) {}
  if (dicaVista >= 3 || reduzido) dica.hidden = true;
  else { try { localStorage.setItem("jarvis_dica_avatar", String(dicaVista + 1)); } catch (_) {} setTimeout(() => { dica.classList.add("some"); }, 7000); }
  const esconderDica = () => { dica.classList.add("some"); };
  canvas.addEventListener("pointerdown", esconderDica, { passive: true });
  let avLigado = false;
  function ligarAvatar() {
    const a = av(); if (!a || avLigado || !a.aoToque) return; avLigado = true;
    a.aoToque(() => { try { if (window.JarvisSfx) window.JarvisSfx.tocar("ouvir"); if (navigator.vibrate) navigator.vibrate(8); } catch (_) {} });
  }

  // ---------- laço: anel, linhas e cronômetro ----------
  let ult = 0, ultFios = 0, ultTexto = "", ultZoom = "";
  const circ = (r) => 2 * Math.PI * r;
  function tick(now) {
    requestAnimationFrame(tick);
    if (document.hidden || now - ult < 33 || orb.offsetParent === null) return;
    ult = now; ligarAvatar();
    const a = av(), g = a && a.geom && a.geom(); if (!g || orb.classList.contains("pequena")) return;
    // cor suave por estado
    const alvo = PAL[estado]; let mudouCor = false;
    for (let i = 0; i < 3; i++) { const d = alvo[i] - corAtual[i]; if (Math.abs(d) > 0.4) { corAtual[i] += d * 0.12; mudouCor = true; } }
    if (mudouCor) raiz.style.setProperty("--estado-rgb", corAtual.map(Math.round).join(" "));
    // anel ao redor da cabeça
    const dur = now - t0, r = Math.max(30, g.r);
    for (const c of [anelBase, anelProg]) { c.setAttribute("cx", g.cx.toFixed(1)); c.setAttribute("cy", g.cy.toFixed(1)); c.setAttribute("r", r.toFixed(1)); }
    const C = circ(r); let prog = 0, rot = 0, txt = "";
    if (estado === "pensando") { prog = 0.26; rot = (now / 1000) * 220; txt = seg(dur); }
    else if (estado === "falando") { prog = Math.min(1, dur / (estimadoFala || 4000)); rot = -90; txt = seg(dur) + " / ~" + seg(estimadoFala).replace(" s", " s"); }
    else if (estado === "ouvindo") { prog = 0.12 + 0.55 * (g.nivel || 0); rot = (now / 1000) * 60; txt = seg(dur); }
    else if (estado === "executando") { prog = 1; rot = -90; txt = ""; }
    else { prog = 0.04; rot = (now / 1000) * 12; txt = ""; }
    anelProg.setAttribute("stroke-dasharray", `${(C * prog).toFixed(1)} ${C.toFixed(1)}`);
    anelProg.setAttribute("transform", `rotate(${rot.toFixed(1)} ${g.cx.toFixed(1)} ${g.cy.toFixed(1)})`);
    if (txt !== ultTexto) { pillTempo.textContent = txt; ultTexto = txt; }
    const zt = g.zoom > 1.02 ? g.zoom.toFixed(1).replace(".", ",") + "×" : "1×"; if (zt !== ultZoom) { zLabel.textContent = zt; zoomBox.classList.toggle("ativo", g.zoom > 1.02); ultZoom = zt; }
    // linhas de energia dos atalhos até a cabeça (só quando orbitam)
    if (!modoEstreito && now - ultFios > 100) {                       // as linhas se atualizam a ~10 quadros/s (leitura de layout é cara)
      ultFios = now;
      const box = orb.getBoundingClientRect(); let i = 0;
      for (const id in satEl) {
        const b = satEl[id].bolha.getBoundingClientRect(); let p = fiosG.children[i];
        if (!p) { p = sv("path", { class: "orb-fio" }); fiosG.appendChild(p); }
        const sx = b.left + b.width / 2 - box.left, sy = b.top + b.height / 2 - box.top, mx = (sx + g.cx) / 2, my = Math.min(sy, g.cy) - 18;
        p.setAttribute("d", `M${sx.toFixed(1)} ${sy.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${g.cx.toFixed(1)} ${g.cy.toFixed(1)}`);
        p.style.strokeDashoffset = reduzido ? 0 : (-(now / 60) % 18).toFixed(1); i++;
      }
    }
  }
  requestAnimationFrame(tick);

  // ---------- acabamento: fundo vivo, destaque que segue o cursor e entrada escalonada ----------
  const malha = el("div", "malha"); malha.setAttribute("aria-hidden", "true"); malha.append(el("i", "b1"), el("i", "b2"), el("i", "b3")); document.body.prepend(malha);
  document.addEventListener("pointermove", (e) => {
    const p = e.target.closest && e.target.closest(".panel"); if (!p) return;
    const r = p.getBoundingClientRect(); p.style.setProperty("--mx", (e.clientX - r.left) + "px"); p.style.setProperty("--my", (e.clientY - r.top) + "px");
  }, { passive: true });
  document.querySelectorAll(".stage .panel, .page-heading, .composer, .barra").forEach((n, i) => n.style.setProperty("--i", i));
  raiz.dataset.vida = "1";
})();
