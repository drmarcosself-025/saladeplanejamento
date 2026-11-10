// Controlador do Jarvis: liga voz, cérebro, dados, avatar e painéis.
(function () {
  const MODOS = window.JARVIS_MODES;
  const $ = (id) => document.getElementById(id);
  const avatar = JarvisAvatar.criar($("avatar"));
  const LOG_KEY = "jarvis_log_v1";

  let modoId = "normal";
  let dados = {};
  let pendente = null;          // ação aguardando "confirma"
  let geracao = 0;              // invalida falas antigas quando chega pedido novo
  let estado = "idle";
  let acordadoAte = 0;          // janela em que a voz dispensa dizer "Jarvis"

  // ---------- registro de interações (coleta de dados) ----------
  function lerLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch (_) { return []; } }
  function gravarLog(item) {
    const l = lerLog(); l.push({ ts: new Date().toISOString(), modo: modoId, ...item });
    try { localStorage.setItem(LOG_KEY, JSON.stringify(l.slice(-200))); } catch (_) {}
    renderLog();
  }
  function renderLog() {
    const ol = $("logLista"); ol.textContent = "";
    for (const e of lerLog().slice(-60).reverse()) {
      const li = document.createElement("li");
      li.textContent = `${e.ts.slice(11, 19)} [${e.modo}] ${e.tipo}${e.entrada ? " ← “" + e.entrada + "”" : ""}${e.fonte ? " · " + e.fonte : ""}`;
      ol.appendChild(li);
    }
  }

  // ---------- estado visual ----------
  function setEstado(e) {
    estado = e; avatar.setEstado(e);
    document.querySelectorAll("#estados li").forEach((li) => li.classList.toggle("on", li.dataset.estado === e));
  }
  function legenda(t) { $("legenda").textContent = t || ""; }
  async function dizer(texto, g) {
    legenda(texto); setEstado("falando");
    await JarvisVoice.falar(texto);
    if (g === geracao) setEstado(JarvisVoice.escutando ? "ouvindo" : "idle");
  }

  // ---------- render de painéis ----------
  function renderChips() {
    const nav = $("chips"); nav.textContent = "";
    for (const id of JARVIS_ORDEM) {
      const m = MODOS[id], b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.dataset.modo = id;
      b.style.setProperty("--c", m.cor);
      b.textContent = m.nome;
      if (m.status !== "demo" && m.status !== "ativo") b.title = "Planejado — ainda sem integração";
      b.addEventListener("click", () => processar("ativa " + m.aliases[0], "clique"));
      nav.appendChild(b);
    }
  }
  function renderModo() {
    const m = MODOS[modoId];
    document.documentElement.style.setProperty("--accent", m.cor);
    avatar.setCor(m.cor);
    $("agNome").textContent = m.nome;
    const st = $("agStatus"); st.textContent = m.status; st.className = "tag " + m.status;
    $("agResumo").textContent = m.resumo;
    const dl = $("kpis"); dl.textContent = "";
    for (const [k, v] of m.kpis(dados)) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k; dd.textContent = v; dl.append(dt, dd);
    }
    const ul = $("ferramentas"); ul.textContent = "";
    for (const f of m.ferramentas) {
      const li = document.createElement("li"), n = document.createElement("b");
      n.className = "n " + f.nivel; n.textContent = f.nivel;
      li.append(n, " " + f.desc); li.title = f.id; ul.appendChild(li);
    }
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.modo === modoId));
    const badge = $("badgeFonte");
    const live = dados.source === "live";
    badge.textContent = modoId === "normal" ? "—" : live ? "AO VIVO" : "DEMO";
    badge.className = "badge " + (live ? "live" : "demo");
    $("cerebro").textContent = "cérebro: " + (window.APP_CONFIG.BRAIN_URL ? "Claude (backend)" : "local");
  }
  function renderPendente() {
    $("painelPendente").hidden = !pendente;
    if (!pendente) return;
    $("pendTitulo").textContent = pendente.titulo;
    const ul = $("pendDetalhe"); ul.textContent = "";
    for (const d of pendente.detalhe || []) { const li = document.createElement("li"); li.textContent = d; ul.appendChild(li); }
    $("pendExemplo").textContent = pendente.exemplo ? "Mensagem: " + pendente.exemplo : "";
    $("pendNota").textContent = dados.source === "live" ? "" : "Demonstração: confirmar não envia nada de verdade.";
  }

  // ---------- fluxo principal ----------
  async function ativar(id, g, prefixo) {
    setEstado("pensando");
    modoId = id; pendente = null; renderPendente();
    dados = id === "normal" ? {} : await JarvisData.get(id);
    if (g !== geracao) return;
    renderModo();
    gravarLog({ tipo: "ativar", fonte: dados.source });
    await dizer((prefixo ? prefixo + " " : "") + MODOS[id].abertura(dados), g);
  }

  async function processar(texto, origem) {
    const g = ++geracao;
    JarvisVoice.parar();
    const it = JarvisBrain.interpretar(texto, MODOS);
    if (it.tipo === "vazio") return;
    acordadoAte = Date.now() + 12000;
    gravarLog({ tipo: it.tipo, entrada: texto, fonte: origem });

    if (it.tipo === "ativar") return ativar(it.modo, g);
    if (it.tipo === "sair") {
      const era = MODOS[modoId];
      return ativar("normal", g, era.id === "normal" ? "" : `Modo ${era.nome} desativado.`);
    }
    if (it.tipo === "cancelar") {
      if (!pendente) return dizer("Não há nada aguardando confirmação.", g);
      pendente = null; renderPendente();
      return dizer("Cancelado. Nada foi feito.", g);
    }
    if (it.tipo === "confirmar") {
      if (!pendente) return dizer("Não há nada aguardando confirmação.", g);
      const p = pendente; pendente = null; renderPendente();
      gravarLog({ tipo: "executar", entrada: p.id, fonte: dados.source });
      // Execução real: POST ao backend com o id da ação. Sem backend: simulação explícita.
      return dizer(
        dados.source === "live"
          ? "Feito."
          : `Confirmado em demonstração: ${p.titulo}. Nada foi enviado de verdade, porque o backend ainda não está ligado.`,
        g
      );
    }
    // pergunta aberta
    setEstado("pensando"); legenda("…");
    const r = await JarvisBrain.perguntar({ modoId, texto, dados });
    if (g !== geracao) return;
    if (r.acao) { pendente = r.acao; renderPendente(); }
    gravarLog({ tipo: "resposta", fonte: r.fonte });
    return dizer(r.fala, g);
  }

  // ---------- eventos ----------
  $("barra").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("entrada").value.trim(); $("entrada").value = "";
    if (v) processar(v, "texto");
  });
  $("btnConfirmar").addEventListener("click", () => processar("confirma", "clique"));
  $("btnCancelar").addEventListener("click", () => processar("cancela", "clique"));
  $("btnMic").addEventListener("click", () => {
    const on = JarvisVoice.alternarEscuta();
    $("btnMic").setAttribute("aria-pressed", String(!!on));
    $("btnMic").classList.toggle("on", !!on);
    if (on) setEstado("ouvindo"); else if (estado === "ouvindo") setEstado("idle");
  });
  $("btnMudo").addEventListener("click", () => {
    JarvisVoice.mudo = !JarvisVoice.mudo;
    $("btnMudo").textContent = JarvisVoice.mudo ? "🔇" : "🔊";
    $("btnMudo").setAttribute("aria-pressed", String(JarvisVoice.mudo));
  });
  $("btnTec").addEventListener("click", () => { $("tecnico").hidden = !$("tecnico").hidden; renderLog(); });
  $("btnLimpar").addEventListener("click", () => { try { localStorage.removeItem(LOG_KEY); } catch (_) {} renderLog(); });
  $("btnExportar").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(lerLog(), null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "jarvis-log.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  JarvisVoice.configurar({
    onTexto(t) {
      if (estado === "falando") return;                 // ignora o eco da própria voz
      const chamou = /\bjarvis\b/i.test(JarvisBrain.norm(t));
      if (!chamou && Date.now() > acordadoAte) return;  // exige “Jarvis” fora da janela
      processar(t, "voz");
    },
    onEstado(on) { $("btnMic").classList.toggle("on", on); },
    onErro(msg) { legenda(msg); },
  });

  setInterval(() => { $("relogio").textContent = new Date().toLocaleTimeString("pt-BR"); }, 1000);

  // ---------- início ----------
  renderChips(); renderModo(); setEstado("idle"); renderLog();
  legenda("Pronto. Diga “Jarvis, ativa o agente gestão do dia”, escolha um agente acima ou digite um pedido.");
  if (!JarvisVoice.suportaEntrada) $("btnMic").title = "Este navegador não tem reconhecimento de voz (use Chrome ou Edge)";
})();
