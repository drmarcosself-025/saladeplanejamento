// Controlador do Jarvis: liga voz, cérebro, dados, avatar e painéis.
(function () {
  const MODOS = window.JARVIS_MODES;
  const $ = (id) => document.getElementById(id);
  const avatar = JarvisAvatar.criar($("avatar"));
  const LOG_KEY = "jarvis_log_v1", CT_KEY = "jarvis_contatos_v1";
  const EXPIRA_MS = 10 * 60 * 1000;           // ação pendente vale 10 minutos

  let modoId = "normal";
  let dados = {};
  let pendente = null;          // ação aguardando "confirma"
  let aguardando = null;        // pedido em andamento: falta o texto ou a escolha do contato
  let geracao = 0;              // invalida falas antigas quando chega pedido novo
  let estado = "idle";
  let acordadoAte = 0;          // janela em que a voz contínua dispensa dizer "Jarvis"
  let infoVoz = JarvisVoice.info();

  // ---------- armazenamento seguro (pode falhar em janela privada) ----------
  const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (_) { return []; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  // ---------- registro de interações (só neste navegador) ----------
  function gravarLog(item) {
    const l = ler(LOG_KEY); l.push({ ts: new Date().toISOString(), modo: modoId, ...item });
    gravar(LOG_KEY, l.slice(-200)); renderLog();
  }
  function renderLog() {
    const ol = $("logLista"); ol.textContent = "";
    for (const e of ler(LOG_KEY).slice(-60).reverse()) {
      const li = document.createElement("li");
      li.textContent = `${e.ts.slice(11, 19)} [${e.modo}] ${e.tipo}${e.entrada ? " ← “" + e.entrada + "”" : ""}${e.fonte ? " · " + e.fonte : ""}`;
      ol.appendChild(li);
    }
  }
  async function exportarLog() {
    const json = JSON.stringify(ler(LOG_KEY), null, 2);
    try {   // dentro do artefato: save() com confirmação do usuário
      const dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
      if (dl) { await dl.save({ filename: "jarvis-log.json", data: json }); return; }
    } catch (e) { if (e && e.code === "declined") return; }
    try { await navigator.clipboard.writeText(json); legenda("Registro copiado para a área de transferência."); return; } catch (_) {}
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" })); a.download = "jarvis-log.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- conversa (só na tela, não é guardada) ----------
  const conversa = [];
  function registrarConversa(quem, texto) {
    conversa.push({ quem, texto }); if (conversa.length > 30) conversa.shift();
    const ol = $("conversa"); ol.textContent = "";
    for (const c of conversa) { const li = document.createElement("li"); li.className = c.quem; li.textContent = c.texto; ol.appendChild(li); }
    ol.scrollTop = ol.scrollHeight;
  }

  // ---------- contatos (só neste navegador) ----------
  const lerContatos = () => ler(CT_KEY).filter((c) => c && c.nome && c.tel).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  function renderContatos() {
    const l = lerContatos(), ul = $("contatosLista"); ul.textContent = "";
    $("contatosTitulo").textContent = `Contatos (${l.length})`;
    for (const c of l) {
      const li = document.createElement("li"), esq = document.createElement("div"), s = document.createElement("span"), t = document.createElement("span"), x = document.createElement("button");
      s.textContent = c.nome; t.className = "tel"; t.textContent = c.tel;
      x.type = "button"; x.textContent = "✕"; x.title = "Remover " + c.nome; x.setAttribute("aria-label", "Remover " + c.nome);
      x.addEventListener("click", () => { gravar(CT_KEY, lerContatos().filter((k) => !(k.nome === c.nome && k.tel === c.tel))); renderContatos(); renderSugestoes(); });
      esq.append(s, document.createElement("br"), t); li.append(esq, x); ul.appendChild(li);
    }
  }

  // ---------- estado visual ----------
  function setEstado(e) {
    estado = e; avatar.setEstado(e);
    document.querySelectorAll("#estados li").forEach((li) => li.classList.toggle("on", li.dataset.estado === e));
  }
  function legenda(t) { $("legenda").textContent = t || ""; }
  async function dizer(texto, g) {
    legenda(texto); registrarConversa("jarvis", texto); setEstado("falando");
    await JarvisVoice.falar(texto);
    if (g === geracao) setEstado(JarvisVoice.escutando ? "ouvindo" : "idle");
  }

  // ---------- render de painéis ----------
  function renderChips() {
    const nav = $("chips"); nav.textContent = "";
    for (const id of JARVIS_ORDEM) {
      const m = MODOS[id], b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.dataset.modo = id; b.style.setProperty("--c", m.cor);
      b.textContent = m.nome;
      if (m.status !== "demo" && m.status !== "ativo") b.title = "Planejado: ainda sem integração";
      b.addEventListener("click", () => processar("ativa " + m.aliases[0], "clique"));
      nav.appendChild(b);
    }
  }
  function renderSugestoes() {
    const box = $("sugestoes"); box.textContent = "";
    const lista = MODOS[modoId].sugestoes.map((s) => ({ rotulo: s, cmd: s }));
    const c = lerContatos()[0];
    if (c) lista.push({ rotulo: "Mandar mensagem para " + c.nome.split(" ")[0], cmd: "manda mensagem pro " + c.nome });
    for (const s of lista) {
      const b = document.createElement("button"); b.type = "button"; b.className = "sug"; b.textContent = s.rotulo;
      b.addEventListener("click", () => processar(s.cmd, "clique")); box.appendChild(b);
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
      n.className = "n " + f.nivel; n.textContent = f.nivel; li.append(n, " " + f.desc); li.title = f.id; ul.appendChild(li);
    }
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.modo === modoId));
    const badge = $("badgeFonte"), live = dados.source === "live";
    badge.hidden = modoId === "normal";
    badge.textContent = live ? "AO VIVO" : "DEMO"; badge.className = "badge " + (live ? "live" : "demo");
    $("cerebro").textContent = "cérebro: " + (window.APP_CONFIG.BRAIN_URL ? "Claude (backend)" : "local");
    renderSugestoes();
  }
  function renderPendente() {
    const p = pendente;
    $("painelPendente").hidden = !p;
    if (!p) return;
    $("pendTitulo").textContent = p.titulo;
    const ul = $("pendDetalhe"); ul.textContent = "";
    for (const d of p.detalhe || []) { const li = document.createElement("li"); li.textContent = d; ul.appendChild(li); }
    $("pendExemplo").textContent = p.exemplo ? "Mensagem: " + p.exemplo : "";
    // Ação com link (WhatsApp): o botão é um link de verdade, que o navegador sempre deixa abrir.
    $("linkWa").hidden = !p.url; $("btnConfirmar").hidden = !!p.url;
    if (p.url) $("linkWa").href = p.url;
    $("pendNota").textContent = p.url
      ? "Abre o WhatsApp com a mensagem pronta. Nada é enviado sozinho: você toca em enviar."
      : dados.source === "live" ? "" : "Demonstração: confirmar não envia nada de verdade.";
  }
  const expirada = () => pendente && Date.now() - pendente.criadoEm > EXPIRA_MS;
  function definirPendente(p) { pendente = { ...p, criadoEm: Date.now() }; renderPendente(); }

  // ---------- fluxo principal ----------
  async function ativar(id, g, prefixo) {
    setEstado("pensando");
    modoId = id; pendente = null; aguardando = null; renderPendente();
    dados = id === "normal" ? {} : await JarvisData.get(id);
    if (g !== geracao) return;
    renderModo();
    gravarLog({ tipo: "ativar", fonte: dados.source });
    await dizer((prefixo ? prefixo + " " : "") + MODOS[id].abertura(dados), g);
  }

  // Monta a ação "abrir WhatsApp com a mensagem pronta" (precisa do seu confirma).
  async function prepararMensagem(contato, msg, g) {
    if (!msg) { aguardando = { tipo: "texto", contato }; return dizer(`O que eu digo para ${contato.nome}?`, g); }
    const url = JarvisBrain.linkWhatsapp(contato.tel, msg);
    if (!url) { $("painelContatos").open = true; return dizer(`O telefone de ${contato.nome} parece inválido. Corrija no painel de contatos.`, g); }
    definirPendente({ id: "whatsapp.abrir", nivel: "EXECUTE", titulo: `Abrir WhatsApp de ${contato.nome}`, detalhe: [`${contato.nome} · ${contato.tel}`], exemplo: msg, url });
    return dizer(`Preparei para ${contato.nome}: ${msg}. Diga confirma para abrir o WhatsApp com a mensagem pronta.`, g);
  }
  async function continuarAguardando(texto, g) {
    const a = aguardando; aguardando = null;
    if (a.tipo === "escolha") {
      const r = JarvisBrain.acharContato(texto, a.opcoes);
      if (r.length !== 1) { aguardando = a; return dizer(`Não entendi qual. Diga o nome completo: ${a.opcoes.map((c) => c.nome).join(", ")}.`, g); }
      return prepararMensagem(r[0], a.mensagem, g);
    }
    const msg = texto.trim();
    return prepararMensagem(a.contato, msg.charAt(0).toUpperCase() + msg.slice(1), g);
  }

  async function processarInterno(texto, origem) {
    const g = ++geracao;
    JarvisVoice.parar();
    const it = JarvisBrain.interpretar(texto, MODOS);
    if (it.tipo === "vazio") return;
    acordadoAte = Date.now() + 12000;
    registrarConversa("voce", texto.trim());
    gravarLog({ tipo: it.tipo, entrada: texto, fonte: origem });

    // Meio de um pedido (falta o texto ou a escolha do contato): a próxima frase
    // é a resposta, a não ser que seja um comando de verdade.
    if (aguardando) {
      const comando = ["sair", "cancelar", "ativar", "confirmar"].includes(it.tipo) || (aguardando.tipo === "texto" && it.tipo === "mensagem");
      if (!comando) return continuarAguardando(texto, g);
      if (it.tipo === "cancelar") { aguardando = null; return dizer("Cancelado.", g); }
      if (it.tipo !== "confirmar") aguardando = null;
    }

    if (it.tipo === "mensagem") {
      const lista = lerContatos(), achados = JarvisBrain.acharContato(it.nome, lista);
      if (!achados.length) {
        $("painelContatos").open = true;
        return dizer(lista.length ? `Não achei ${it.nome} nos seus contatos. Cadastre no painel de contatos e peça de novo.`
                                  : "Você ainda não cadastrou nenhum contato. Adicione no painel de contatos e peça de novo.", g);
      }
      if (achados.length > 1) {
        aguardando = { tipo: "escolha", opcoes: achados, mensagem: it.mensagem };
        return dizer(`Achei ${achados.length}: ${achados.map((c) => c.nome).join(", ")}. Qual deles?`, g);
      }
      return prepararMensagem(achados[0], it.mensagem, g);
    }
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
      if (expirada()) { pendente = null; renderPendente(); return dizer("Essa ação expirou depois de 10 minutos. Peça de novo.", g); }
      const p = pendente;
      if (p.url) {
        // Se a confirmação veio de clique, o navegador deixa abrir; se veio de voz,
        // pode bloquear: então destaca o botão (um link de verdade) e pede o toque.
        let w = null; try { w = window.open(p.url, "_blank"); } catch (_) {}
        if (!w) {
          const a = $("linkWa"); a.classList.remove("pulsa"); void a.offsetWidth; a.classList.add("pulsa");
          return dizer("Pronto. Toque em Abrir WhatsApp para continuar.", g);
        }
        try { w.opener = null; } catch (_) {}
        pendente = null; renderPendente();
        gravarLog({ tipo: "executar", entrada: p.id, fonte: "local" });
        return dizer("Abri o WhatsApp com a mensagem pronta. É só tocar em enviar.", g);
      }
      pendente = null; renderPendente();
      gravarLog({ tipo: "executar", entrada: p.id, fonte: dados.source });
      return dizer(dados.source === "live" ? "Feito."
        : `Confirmado em demonstração: ${p.titulo}. Nada foi enviado de verdade, porque o backend ainda não está ligado.`, g);
    }
    // pergunta aberta
    setEstado("pensando"); legenda("…");
    const r = await JarvisBrain.perguntar({ modoId, texto, dados });
    if (g !== geracao) return;
    if (r.acao) definirPendente(r.acao);
    gravarLog({ tipo: "resposta", fonte: r.fonte });
    return dizer(r.fala, g);
  }
  // Nenhum erro deixa o Jarvis preso em "pensando".
  async function processar(texto, origem) {
    try { return await processarInterno(texto, origem); }
    catch (e) {
      console.error(e); setEstado("idle");
      legenda("Algo deu errado com esse pedido. Tente de novo.");
      gravarLog({ tipo: "erro", entrada: String((e && e.message) || e).slice(0, 120), fonte: origem });
    }
  }

  // ---------- entrada: texto, cliques, teclado ----------
  $("barra").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("entrada").value.trim(); $("entrada").value = "";
    if (v) processar(v, "texto");
  });
  $("btnConfirmar").addEventListener("click", () => processar("confirma", "clique"));
  $("btnCancelar").addEventListener("click", () => processar("cancela", "clique"));
  $("linkWa").addEventListener("click", () => {      // link real: deixa abrir e só registra
    const p = pendente; if (!p) return;
    gravarLog({ tipo: "executar", entrada: p.id, fonte: "local" });
    setTimeout(() => { pendente = null; renderPendente(); legenda("Abri o WhatsApp com a mensagem pronta. É só tocar em enviar."); }, 150);
  });

  $("contatoForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const nome = $("contatoNome").value.trim().replace(/\s+/g, " "), tel = $("contatoTel").value.trim(), erro = $("contatoErro");
    const url = JarvisBrain.linkWhatsapp(tel, "");
    const mostrar = (m) => { erro.textContent = m; erro.hidden = false; };
    if (!url) return mostrar("Telefone inválido. Use DDD + número, ex.: 63 99999-0000.");
    const l = lerContatos();
    if (l.some((c) => JarvisBrain.linkWhatsapp(c.tel, "") === url)) return mostrar("Esse telefone já está nos contatos.");
    erro.hidden = true; l.push({ nome, tel }); gravar(CT_KEY, l);
    $("contatoNome").value = ""; $("contatoTel").value = ""; renderContatos(); renderSugestoes();
  });

  // Microfone contínuo (só em navegador comum)
  $("btnMic").addEventListener("click", async () => {
    const on = await JarvisVoice.alternarEscuta();
    $("btnMic").setAttribute("aria-pressed", String(!!on)); $("btnMic").classList.toggle("on", !!on);
  });

  // Segurar para falar: botão (mouse/toque) ou Espaço fora de campos de texto.
  // Em artefato, o ditado precisa começar DIRETO do clique/tecla: sem await antes.
  const btnPtt = $("btnPtt");
  function pttInicio() {
    if (JarvisVoice.segurando || JarvisVoice.escutando) return;
    btnPtt.classList.add("ptt-on");
    JarvisVoice.segurar().then((ok) => { if (!ok) btnPtt.classList.remove("ptt-on"); });
  }
  function pttFim() { btnPtt.classList.remove("ptt-on"); JarvisVoice.soltar(); }
  btnPtt.addEventListener("pointerdown", (e) => { e.preventDefault(); try { btnPtt.setPointerCapture(e.pointerId); } catch (_) {} pttInicio(); });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => btnPtt.addEventListener(ev, pttFim));
  const emCampo = () => /^(input|textarea|select|button|a)$/i.test(document.activeElement && document.activeElement.tagName);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space" && !e.repeat && !emCampo() && !btnPtt.disabled) { e.preventDefault(); pttInicio(); return; }
    if (e.key === "/" && !emCampo()) { e.preventDefault(); $("entrada").focus(); return; }
    if (e.key === "Escape" && !/^(input|textarea|select)$/i.test(document.activeElement.tagName)) {
      if (estado === "falando") { geracao++; JarvisVoice.parar(); setEstado("idle"); }
      else if (pendente) processar("cancela", "tecla");
    }
  });
  document.addEventListener("keyup", (e) => { if (e.code === "Space" && JarvisVoice.segurando) pttFim(); });

  $("btnMudo").addEventListener("click", () => {
    JarvisVoice.mudo = !JarvisVoice.mudo;
    $("btnMudo").textContent = JarvisVoice.mudo ? "🔇" : "🔊"; $("btnMudo").setAttribute("aria-pressed", String(JarvisVoice.mudo));
  });
  $("btnTec").addEventListener("click", () => { $("tecnico").hidden = !$("tecnico").hidden; renderLog(); });
  $("btnLimpar").addEventListener("click", () => { gravar(LOG_KEY, []); renderLog(); });
  $("btnExportar").addEventListener("click", exportarLog);

  // ---------- painel de voz ----------
  function popularVozes() {
    const sel = $("vozSel"), nomes = JarvisVoice.vozes();
    sel.textContent = "";
    if (!nomes.length) { const o = document.createElement("option"); o.textContent = "(sem escolha de voz neste navegador)"; sel.appendChild(o); sel.disabled = true; return; }
    sel.disabled = false;
    for (const n of nomes) { const o = document.createElement("option"); o.value = o.textContent = n; sel.appendChild(o); }
    sel.value = JarvisVoice.vozAtual;
  }
  $("vozSel").addEventListener("change", (e) => JarvisVoice.setVoz(e.target.value));
  const velTxt = () => { $("velVal").textContent = JarvisVoice.velocidade.toFixed(2) + "×"; };
  $("velocidade").value = JarvisVoice.velocidade; velTxt();
  $("velocidade").addEventListener("input", (e) => { JarvisVoice.setVelocidade(e.target.value); velTxt(); });
  $("btnTestarVoz").addEventListener("click", () => {
    const g = ++geracao; legenda("Olá, eu sou o Jarvis. Esta é a minha voz."); setEstado("falando");
    JarvisVoice.testar().then(() => { if (g === geracao) setEstado("idle"); });
  });

  // Ajusta a tela ao que a voz realmente oferece onde a página está rodando.
  function aplicarVoz(i) {
    infoVoz = i;
    const semEntrada = !i.entrada;
    btnPtt.disabled = semEntrada;
    btnPtt.title = semEntrada ? "Ditado indisponível aqui (use Chrome ou Edge no claude.ai, ou localhost). Você pode digitar." : "Segure para falar (ou segure a tecla Espaço)";
    $("btnMic").hidden = !i.continuo; $("btnMic").disabled = !i.continuo;
    $("medidorBox").hidden = i.entrada !== "navegador";
    $("btnMudo").disabled = !i.saida;
    $("vozInfo").textContent =
      (i.saida === "claude" ? "Voz: Claude." : i.saida === "navegador" ? "Voz: do seu sistema." : "Sem voz neste navegador/app: o texto aparece na tela.") + " " +
      (i.entrada === "ditado" ? "Entrada: ditado do claude.ai." : i.entrada === "navegador" ? "Entrada: reconhecimento do navegador." : "Entrada por voz indisponível: digite.");
    $("vozComo").textContent = i.entrada === "ditado"
      ? "Segure 🗣 (ou a tecla Espaço) enquanto fala e solte para enviar."
      : i.continuo ? "🗣 escuta só enquanto você segura. 🎙 fica ouvindo e só responde quando ouvir “Jarvis”." : "";
    $("avisoPriv").textContent = i.entrada === "ditado"
      ? "Privacidade: o áudio vai ao serviço de fala da Anthropic (o mesmo do chat) e a página recebe só o texto. Ao falar nome de paciente, considere digitar."
      : "Privacidade: no Chrome/Edge o reconhecimento de fala é feito pelo servidor do navegador (Google/Microsoft), então o áudio sai do seu computador. A voz do Jarvis é local. Ao falar nome de paciente, considere digitar.";
    popularVozes();
  }
  JarvisVoice.configurar({
    onTexto(t, meta) {
      // Segurar para falar: foi de propósito, dispensa dizer “Jarvis”.
      if (meta && meta.ptt) { $("interim").textContent = ""; return processar(t, "voz-ptt"); }
      if (estado === "falando") return;                                   // ignora o eco da própria voz
      if (!JarvisBrain.chamou(t) && Date.now() > acordadoAte) return;     // contínuo: exige “Jarvis”
      processar(t, "voz");
    },
    onInterim(t) {
      $("interim").textContent = t ? "🎙 " + t : "";
      if (t && infoVoz.entrada === "ditado") pulso(0.45 + Math.random() * 0.4);   // sem medidor real: reage ao texto
    },
    onNivel(n) { avatar.setNivel(n); $("medidor").style.width = Math.round(n * 100) + "%"; },
    onEstado(on) {
      if (on && estado !== "falando") setEstado("ouvindo");
      else if (!on && estado === "ouvindo") setEstado("idle");
    },
    onErro(msg) {
      legenda(msg);
      $("btnMic").classList.remove("on"); $("btnMic").setAttribute("aria-pressed", "false"); btnPtt.classList.remove("ptt-on");
    },
    onVozes() { popularVozes(); },
  });
  let pulsoT = 0;
  function pulso(n) { avatar.setNivel(n); clearTimeout(pulsoT); pulsoT = setTimeout(() => avatar.setNivel(0), 220); }

  setInterval(() => { $("relogio").textContent = new Date().toLocaleTimeString("pt-BR"); }, 1000);

  // ---------- início ----------
  renderChips(); renderModo(); setEstado("idle"); renderLog(); renderContatos(); aplicarVoz(infoVoz);
  JarvisVoice.pronto.then(aplicarVoz);
  if (window.matchMedia && matchMedia("(max-width:900px)").matches) $("entrada").placeholder = "Fale ou digite um pedido…";
  legenda("Pronto. Escolha um agente acima, toque numa sugestão, segure 🗣 para falar ou digite um pedido.");
})();
