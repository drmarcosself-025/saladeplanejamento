// Controlador do Jarvis: liga voz, cérebro, dados, avatar e painéis.
(function () {
  const MODOS = window.JARVIS_MODES;
  const $ = (id) => document.getElementById(id);
  const avatar = JarvisAvatar.criar($("avatar"));
  const fundo = JarvisFundo.criar($("fundo"));
  const sfx = (n) => JarvisSfx.tocar(n);
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
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } };

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
  // Salva um arquivo: no claude.ai pede confirmação (downloads); fora dele, baixa; senão copia.
  async function salvarArquivo(nome, conteudo, tipo) {
    try {
      const dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
      if (dl) { await dl.save({ filename: nome, data: conteudo }); return; }
    } catch (e) { if (e && e.code === "declined") return; }
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo })); a.download = nome; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000); return;
    } catch (_) {}
    try { await navigator.clipboard.writeText(conteudo); legenda("Conteúdo copiado para a área de transferência."); } catch (_) {}
  }
  const exportarLog = () => salvarArquivo("jarvis-log.json", JSON.stringify(ler(LOG_KEY), null, 2), "application/json");

  // ---------- conversa (só na tela, não é guardada) ----------
  const conversa = [];
  function registrarConversa(quem, texto) {
    conversa.push({ quem, texto }); if (conversa.length > 30) conversa.shift();
    const ol = $("conversa"); ol.textContent = "";
    for (const c of conversa) { const li = document.createElement("li"); li.className = c.quem; li.textContent = c.texto; ol.appendChild(li); }
    ol.scrollTop = ol.scrollHeight;
  }

  // ---------- contatos (só neste navegador) ----------
  let cacheCt = null;
  const lerContatos = () => cacheCt || (cacheCt = ler(CT_KEY).filter((c) => c && c.nome && c.tel).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")));
  function gravarContatos(l) {
    const ok = gravar(CT_KEY, l);
    cacheCt = null; return ok;
  }
  window.addEventListener("jarvis:restaurado", () => { cacheCt = null; renderContatos(); renderSugestoes(); renderLeads(); renderCrm(); renderFin(); });
  const MAX_LISTA = 40;
  function renderContatos() {
    const todos = lerContatos(), ul = $("contatosLista"); ul.textContent = "";
    $("contatosTitulo").textContent = `Contatos (${todos.length})`;
    const q = JarvisBrain.norm($("buscaContato").value), qd = q.replace(/\D/g, "");
    const lista = q ? todos.filter((c) => JarvisBrain.norm(c.nome).includes(q) || (qd.length >= 3 && c.tel.replace(/\D/g, "").includes(qd))) : todos;
    for (const c of lista.slice(0, MAX_LISTA)) {
      const li = document.createElement("li"), esq = document.createElement("div"), s = document.createElement("span"), t = document.createElement("span"), x = document.createElement("button");
      s.textContent = c.nome; t.className = "tel"; t.textContent = c.tel;
      x.type = "button"; x.textContent = "✕"; x.title = "Remover " + c.nome; x.setAttribute("aria-label", "Remover " + c.nome);
      x.addEventListener("click", () => { gravarContatos(lerContatos().filter((k) => !(k.nome === c.nome && k.tel === c.tel))); renderContatos(); renderSugestoes(); });
      esq.append(s, document.createElement("br"), t); li.append(esq, x); ul.appendChild(li);
    }
    $("contatosMais").textContent = !todos.length ? "Nenhum contato ainda. Importe um arquivo ou adicione um por um."
      : !lista.length ? "Nenhum contato encontrado."
      : lista.length > MAX_LISTA ? `Mostrando ${MAX_LISTA} de ${lista.length}. Digite na busca para achar um contato.` : "";
  }
  function msgImporta(texto, tipo) { const el = $("importaMsg"); el.textContent = texto; el.className = "small " + (tipo || "muted"); }

  async function importarArquivo(file) {
    if (file.size > 15 * 1024 * 1024) return msgImporta("Arquivo grande demais (limite de 15 MB).", "erro");
    try {
      const buf = await file.arrayBuffer();
      let texto = new TextDecoder("utf-8").decode(buf);
      if (texto.includes("\uFFFD")) texto = new TextDecoder("windows-1252").decode(buf);   // CSV antigo do Windows
      aplicarImportacao(JarvisContatos.importar(texto, file.name));
    } catch (_) { msgImporta("Não consegui ler esse arquivo. Exporte os contatos como vCard (.vcf) ou CSV.", "erro"); sfx("erro"); }
  }
  function aplicarImportacao(r) {
    if (!r.contatos.length) {
      msgImporta(r.lidos > 1 || r.semTelefone !== r.lidos ? `Li ${r.lidos} contatos, mas nenhum tem celular válido (${r.semTelefone} sem telefone, ${r.fixos} fixos, ${r.invalidos} inválidos).`
                         : "Não encontrei contatos nesse arquivo. Use vCard (.vcf) ou CSV com colunas de nome e telefone.", "erro");
      return sfx("erro");
    }
    const m = JarvisContatos.mesclar(lerContatos(), r.contatos);
    if (!gravarContatos(m.lista)) return msgImporta("Não coube no armazenamento do navegador. Importe um arquivo menor ou apague contatos.", "erro");
    renderContatos(); renderSugestoes(); sfx("confirmar");
    const extra = [r.fixos && `${r.fixos} fixos ignorados`, r.semTelefone && `${r.semTelefone} sem telefone`, r.invalidos && `${r.invalidos} inválidos`, (r.repetidosNoArquivo + m.repetidos) && `${r.repetidosNoArquivo + m.repetidos} repetidos`].filter(Boolean);
    msgImporta(`${m.adicionados} contatos importados` + (extra.length ? " · " + extra.join(" · ") : "") + ".", "ok");
  }

  // ---------- leads ----------
  const L = JarvisLeads, NAO_LEAD = Symbol("nao-lead");
  let filtroLeads = "devidos";
  const hojeISO = () => L.iso(new Date());
  // "hoje", "amanhã" ou "sexta-feira, 13/11" (para frases faladas)
  function quandoHumano(d) {
    const dif = Math.round((new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000);
    if (dif === 0) return "hoje"; if (dif === 1) return "amanhã";
    const sem = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"][new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)).getDay()];
    return `${sem}, ${d.slice(8, 10)}/${d.slice(5, 7)}`;
  }
  const primeiro = (n) => String(n).split(" ")[0];
  function listaDoFiltro(todos) {
    if (filtroLeads === "fechados") return todos.filter((l) => !L.ativo(l)).sort((a, b) => String(b.atualizado).localeCompare(String(a.atualizado)));
    if (filtroLeads.startsWith("etapa:")) return L.ordenar(todos.filter((l) => l.etapa === filtroLeads.slice(6)));
    return L.filtrar(todos, filtroLeads);
  }
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function renderLeads() {
    const todos = L.lista(), r = L.resumo(todos), hoje = hojeISO();
    $("leadsTitulo").textContent = `Leads (${r.ativos})`;
    const urgentes = r.hoje + r.atrasados + r.semData;
    $("leadsBadge").hidden = !urgentes; $("leadsBadge").textContent = String(urgentes);
    $("leadsBadge").title = `${urgentes} para retornar (hoje ou atrasados)`;
    $("leadsStatus").textContent = L.aviso || (L.modo === "claude"
      ? "Salvo no claude.ai: aparece igual no iPhone e no computador."
      : "Salvo só neste navegador (o armazenamento do claude.ai não está disponível aqui).");
    $("leadsStatus").className = "small " + (L.aviso ? "bad" : "muted");
    // funil
    const fu = $("funil"); fu.textContent = "";
    for (const e of L.ETAPAS) {
      const b = mk("button", (filtroLeads === "etapa:" + e.id ? "on " : "") + (r.funil[e.id] ? "" : "zero"));
      b.type = "button"; b.append(mk("b", "", String(r.funil[e.id])), document.createTextNode(e.nome));
      b.addEventListener("click", () => { filtroLeads = "etapa:" + e.id; renderLeads(); });
      fu.appendChild(b);
    }
    document.querySelectorAll("#leadsFiltros .fil").forEach((b) => b.classList.toggle("on", b.dataset.f === filtroLeads));
    // lista
    const ul = $("leadsLista"); ul.textContent = "";
    const ls = listaDoFiltro(todos);
    for (const l of ls.slice(0, 60)) {
      const atrasado = L.ativo(l) && l.proximo && l.proximo < hoje, deHoje = L.ativo(l) && l.proximo === hoje;
      const li = mk("li", "lead" + (atrasado ? " atrasado" : deHoje ? " hoje" : ""));
      const topo = mk("div", "lead-topo"); topo.append(mk("strong", "", l.nome), mk("span", "lead-quando", L.ativo(l) ? L.rotulo(l.proximo, hoje) : L.nomeEtapa(l.etapa)));
      const meta = mk("div", "lead-meta", [l.interesse, l.origem, l.tel].filter(Boolean).join(" · "));
      const ac = mk("div", "lead-acoes");
      const sel = mk("select"); sel.setAttribute("aria-label", "Etapa de " + l.nome);
      for (const e of L.ETAPAS) { const o = mk("option", "", e.nome); o.value = e.id; sel.appendChild(o); }
      sel.value = l.etapa; sel.addEventListener("change", () => L.salvar(L.comEtapa(l, sel.value)));
      ac.appendChild(sel);
      if (L.ativo(l)) {
        const ret = mk("button", "btn", "Retornar"); ret.type = "button"; ret.addEventListener("click", () => acaoRetornar(l));
        const mais = mk("button", "btn", "+1 dia"); mais.type = "button"; mais.title = "Adiar o retorno em um dia";
        mais.addEventListener("click", () => L.salvar(L.comProximo(l, L.somar(l.proximo && l.proximo > hoje ? l.proximo : hoje, 1))));
        ac.append(ret, mais);
      }
      const rm = mk("button", "rm", "✕"); rm.type = "button"; rm.title = "Apagar lead"; rm.setAttribute("aria-label", "Apagar " + l.nome);
      rm.addEventListener("click", () => {            // apagar em dois toques, sem janela de confirmação
        if (rm.dataset.armado) { L.remover(l.id); return; }
        rm.dataset.armado = "1"; rm.textContent = "Apagar?"; setTimeout(() => { if (rm.isConnected) { delete rm.dataset.armado; rm.textContent = "✕"; } }, 3000);
      });
      ac.appendChild(rm);
      li.append(topo, meta, ac); ul.appendChild(li);
    }
    $("leadsVazio").textContent = !todos.length ? "Nenhum lead ainda. Diga “novo lead…” ou adicione abaixo."
      : !ls.length ? (filtroLeads === "devidos" ? "Nenhum retorno pendente. Tudo em dia." : "Nenhum lead neste filtro.")
      : ls.length > 60 ? `Mostrando 60 de ${ls.length}.` : "";
  }
  // Mantém os números do modo Leads em dia quando algo muda.
  function atualizarModoLeads() {
    if (modoId !== "leads") return;
    dados = { source: "seus", ...L.resumo(L.lista()) }; renderModo();
  }

  async function prepararRetorno(lead, g) {
    const msg = L.mensagemRetorno(lead), url = JarvisBrain.linkWhatsapp(lead.tel, msg);
    if (!url) return dizer(`O telefone de ${lead.nome} parece inválido. Corrija o lead.`, g);
    definirPendente({
      id: "whatsapp.abrir", nivel: "EXECUTE", titulo: `Retornar para ${lead.nome}`,
      detalhe: [`${lead.nome} · ${lead.tel}`, [L.nomeEtapa(lead.etapa), lead.interesse].filter(Boolean).join(" · ")], exemplo: msg, url, leadId: lead.id,
    });
    return dizer(`Preparei o retorno para ${lead.nome}. Confira a mensagem na tela e diga confirma para abrir o WhatsApp.`, g);
  }
  function acaoRetornar(lead) { const g = ++geracao; JarvisVoice.parar(); return prepararRetorno(lead, g); }

  async function criarLeadComDados(d, g) {
    const novo = L.novo(d);
    if (novo.erro === "fixo") return dizer("Esse parece ser telefone fixo, e fixo não tem WhatsApp. Me passe o celular.", g);
    if (novo.erro) { aguardando = { tipo: "lead_tel", dados: d }; return dizer(`Não entendi o telefone de ${d.nome || "o lead"}. Diga o número com DDD.`, g); }
    $("painelLeads").open = true; filtroLeads = "devidos";
    const ex = L.porId(novo.id);
    if (ex) {
      const ok = await L.salvar(L.garantirRegra({ ...ex, origem: ex.origem || novo.origem, interesse: novo.interesse || ex.interesse, atualizado: novo.atualizado }));
      return dizer(ok ? `${ex.nome} já estava nos leads. Atualizei os dados.` : (L.aviso || "Não consegui salvar."), g);
    }
    if (!(await L.salvar(novo))) return dizer(L.aviso || "Não consegui salvar o lead.", g);
    sfx("confirmar");
    const partes = [novo.origem && `origem ${novo.origem}`, novo.interesse && `interesse em ${novo.interesse}`].filter(Boolean);
    return dizer(`Anotei ${novo.nome} como lead novo${partes.length ? ", " + partes.join(", ") : ""}. Retorno marcado para hoje.`, g);
  }
  // Acha o lead pelo nome (pergunta qual se houver mais de um) e aplica `depois`.
  async function comLead(it, g, depois) {
    const achados = L.buscar(it.nome);
    if (!achados.length) {
      if (it.solto) return NAO_LEAD;                    // "o João fechou" sem lead João: era conversa comum
      $("painelLeads").open = true;
      return dizer(L.lista().length ? `Não achei ${it.nome} nos seus leads.` : "Você ainda não tem leads. Diga: novo lead, nome, telefone, de onde veio e o que quer.", g);
    }
    if (achados.length > 1) {
      aguardando = { tipo: "lead_escolha", opcoes: achados, depois };
      return dizer(`Achei ${achados.length}: ${achados.map((c) => c.nome).join(", ")}. Qual deles?`, g);
    }
    return depois(achados[0], g);
  }
  const aplicarEtapa = (etapa) => async (lead, g) => {
    const novo = L.comEtapa(lead, etapa);
    if (!(await L.salvar(novo))) return dizer(L.aviso || "Não consegui salvar.", g);
    sfx("confirmar");
    if (etapa === "fechou") return dizer(`Parabéns! Marquei ${lead.nome} como fechado. Ele sai da lista de retornos.`, g);
    if (etapa === "sem_interesse") return dizer(`Marquei ${lead.nome} como sem interesse. Ele sai da lista de retornos.`, g);
    if (etapa === "agendou") return dizer(`Marquei ${lead.nome} como agendado. Para marcar o retorno de confirmação, diga: adia o ${primeiro(lead.nome)} para a data da consulta.`, g);
    return dizer(`Marquei ${lead.nome} como ${L.nomeEtapa(etapa).toLowerCase()}. Próximo retorno: ${quandoHumano(novo.proximo)}.`, g);
  };
  const aplicarData = (quando) => async (lead, g) => {
    if (!L.ativo(lead)) return dizer(`${lead.nome} está encerrado (${L.nomeEtapa(lead.etapa).toLowerCase()}). Mude a etapa antes de marcar retorno.`, g);
    if (!(await L.salvar(L.comProximo(lead, quando)))) return dizer(L.aviso || "Não consegui salvar.", g);
    sfx("confirmar");
    return dizer(`Certo. Retorno de ${lead.nome} marcado para ${quandoHumano(quando)}.`, g);
  };

  async function comandoLead(it, g) {
    if (it.tipo === "lead_novo") {
      if (!it.nome) return dizer("Qual o nome e o telefone do lead?", g);
      if (!it.tel) { aguardando = { tipo: "lead_tel", dados: it }; return dizer(`Qual o telefone de ${it.nome}?`, g); }
      return criarLeadComDados(it, g);
    }
    if (it.tipo === "lead_lista") {
      const todos = L.lista(); $("painelLeads").open = true;
      if (!todos.length) { renderLeads(); return dizer("Você ainda não tem leads. Diga: novo lead, nome, telefone, de onde veio e o que quer.", g); }
      const todosAtivos = it.filtro === "todos";
      filtroLeads = todosAtivos ? "todos" : "devidos"; renderLeads();
      const ls = L.filtrar(todos, it.filtro === "atrasados" ? "atrasados" : todosAtivos ? "todos" : "devidos");
      if (!ls.length) return dizer(todosAtivos ? "Nenhum lead ativo no momento." : "Nenhum retorno pendente agora. Tudo em dia.", g);
      mostrarCard(todosAtivos ? "Seus leads ativos" : "Quem espera seu retorno", ls.slice(0, 8).map((l) => `${l.nome} · ${l.interesse || L.nomeEtapa(l.etapa)} · ${L.rotulo(l.proximo, hojeISO())}`), ["abre o CRM"]);
      return dizer(`Você tem ${ls.length} ${todosAtivos ? "leads ativos" : "retornos pendentes"}. Mostrei os detalhes na tela.`, g);
    }
    if (it.tipo === "lead_etapa") return comLead(it, g, aplicarEtapa(it.etapa));
    if (it.tipo === "lead_adiar") {
      if (!it.quando) return comLead(it, g, async (lead, g2) => { aguardando = { tipo: "lead_data", lead }; return dizer(`Para quando marco o retorno de ${lead.nome}? Diga amanhã, sexta, daqui a 3 dias ou dia 20.`, g2); });
      return comLead(it, g, aplicarData(it.quando));
    }
    if (it.tipo === "lead_retorno") return comLead(it, g, prepararRetorno);
    if (it.tipo === "lead_detalhe") return comLead(it, g, async (lead, g2) => { abrirCrm(lead.id); return dizer(`Abri a ficha de ${lead.nome}.`, g2); });
    if (it.tipo === "lead_nota") return comLead(it, g, async (lead, g2) => {
      const ok = await L.salvar(L.comNota(lead, it.nota)); return dizer(ok ? `Anotei na ficha de ${lead.nome}.` : L.aviso || "Não consegui salvar a nota.", g2);
    });
    if (it.tipo === "lead_valor") return comLead(it, g, async (lead, g2) => {
      const ok = await L.salvar(L.comValor(lead, it.valor)); return dizer(ok ? `Valor estimado de ${lead.nome}: ${JarvisFin.brl(it.valor)}.` : L.aviso || "Não consegui salvar o valor.", g2);
    });
    return NAO_LEAD;
  }

  // ---------- áreas de trabalho: CRM e financeiro ----------
  const F = JarvisFin;
  let leadAberto = null, mesFin = F.mesDe(hojeISO());
  const valor = (v) => F.brl(v || 0);
  const limparCard = () => { $("respostaCard").hidden = true; $("respostaItens").textContent = ""; $("respostaAcoes").textContent = ""; };
  async function copiar(t) {
    try { await navigator.clipboard.writeText(t); legenda("Copiado."); }
    catch (_) { legenda("Não consegui copiar aqui. Selecione o texto na tela."); }
  }
  function mostrarCard(titulo, itens, acoes) {
    const box = $("respostaCard"); box.hidden = false; $("respostaTitulo").textContent = titulo || "Detalhes";
    const ul = $("respostaItens"); ul.textContent = "";
    for (const s of (itens || []).slice(0, 8)) {
      const li = mk("li", "", s), b = mk("button", "btn", "Copiar"); b.type = "button";
      b.addEventListener("click", () => copiar(s)); li.prepend(b); ul.appendChild(li);
    }
    const bar = $("respostaAcoes"); bar.textContent = "";
    for (const s of (acoes || []).slice(0, 4)) {
      const b = mk("button", "btn", s); b.type = "button"; b.addEventListener("click", () => processar(s, "clique")); bar.appendChild(b);
    }
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const metricas = (alvo, pares) => {
    const box = $(alvo); box.textContent = "";
    for (const [nome, n] of pares) { const e = mk("div", "metrica"), s = mk("span", "", nome), b = mk("strong", "", String(n)); e.append(s, b); box.appendChild(e); }
  };
  function abrirCrm(id) { $("crmTela").hidden = false; $("finTela").hidden = true; $("rotinaTela").hidden = true; $("socialTela").hidden = true; $("crmTela").querySelector(".workspace-head").after($("respostaCard")); if (id) leadAberto = id; renderCrm(); }
  function fecharAreas() { $("crmTela").hidden = true; $("finTela").hidden = true; $("rotinaTela").hidden = true; $("socialTela").hidden = true; $("legendaSr").after($("respostaCard")); }
  function renderCrm() {
    const ls = L.lista(), r = L.resumo(ls);
    $("crmStatus").textContent = L.aviso || (L.modo === "claude" ? "Dados salvos no seu artefato Claude." : "Dados salvos neste navegador.");
    metricas("crmMetricas", [["Ativos", r.ativos], ["Hoje", r.hoje], ["Atrasados", r.atrasados], ["Valor em aberto (estimado)", valor(r.emAberto)],
      ["Conversão dos encerrados", r.conversao == null ? "—" : Math.round(r.conversao * 100) + "%"], ["Ticket dos fechados", r.ticket == null ? "—" : valor(r.ticket)],
      ["Por origem", Object.entries(r.porOrigem).map(([k,v]) => `${k}: ${v.total}`).join(" · ") || "—"]]);
    const q = $("crmQuadro"); q.textContent = "";
    for (const etapa of L.ETAPAS) {
      const col = mk("section", "crm-coluna"); col.append(mk("h2", "", `${etapa.nome} · ${r.funil[etapa.id] || 0}`));
      col.dataset.etapa = etapa.id;
      col.addEventListener("dragover", (e) => e.preventDefault());
      col.addEventListener("drop", async (e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"), lead = L.porId(id); if (lead) await L.salvar(L.comEtapa(lead, etapa.id)); });
      for (const l of ls.filter((x) => x.etapa === etapa.id)) {
        const card = mk("button", "crm-cartao"); card.type = "button"; card.draggable = true; card.setAttribute("aria-selected", String(leadAberto === l.id));
        card.append(mk("b", "", l.nome), mk("span", "", l.interesse || "Interesse não informado"), mk("span", "", `${l.valor ? valor(l.valor) + " · " : ""}${L.ativo(l) ? L.rotulo(l.proximo, hojeISO()) : "Encerrado"}`));
        card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", l.id)); card.addEventListener("click", () => { leadAberto = l.id; renderCrm(); }); col.appendChild(card);
      }
      q.appendChild(col);
    }
    const d = $("crmDetalhe"), l = L.porId(leadAberto); d.hidden = !l; d.textContent = ""; if (!l) return;
    d.append(mk("h2", "", l.nome), mk("p", "small muted", [l.interesse, l.origem, l.tel].filter(Boolean).join(" · ")));
    const sel = mk("select"); sel.setAttribute("aria-label", "Etapa");
    for (const e of L.ETAPAS) { const op = mk("option", "", e.nome); op.value = e.id; sel.append(op); }
    sel.value = l.etapa; sel.addEventListener("change", async () => { await L.salvar(L.comEtapa(l, sel.value)); }); d.append(sel);
    const val = mk("input"); val.type = "number"; val.min = "0"; val.step = "0.01"; val.placeholder = "Valor estimado em R$"; val.value = l.valor || ""; val.setAttribute("aria-label", "Valor estimado"); d.append(val);
    const nota = mk("textarea"); nota.placeholder = "Nota para o histórico"; nota.setAttribute("aria-label", "Nova nota"); d.append(nota);
    const row = mk("div", "row"), salvar = mk("button", "btn", "Salvar valor e nota"); salvar.type = "button";
    salvar.addEventListener("click", async () => { let novo = l; if (val.value !== String(l.valor || "")) novo = L.comValor(novo, Number(val.value)); if (nota.value.trim()) novo = L.comNota(novo, nota.value); await L.salvar(novo); }); row.append(salvar);
    if (L.ativo(l)) {
      const ret = mk("button", "btn", "Retornar"), feito = mk("button", "btn", "Contato realizado"), adiar = mk("button", "btn", "Adiar 1 dia"); ret.type = feito.type = adiar.type = "button";
      ret.addEventListener("click", () => { fecharAreas(); acaoRetornar(l); });
      feito.addEventListener("click", () => L.salvar(L.aposContato(l)));
      adiar.addEventListener("click", () => L.salvar(L.comProximo(l, L.somar(l.proximo && l.proximo > hojeISO() ? l.proximo : hojeISO(), 1)))); row.append(ret, feito, adiar);
    }
    d.append(row, mk("h2", "", "Histórico")); const ol = mk("ol");
    for (const h of (l.historico || []).slice(-20).reverse()) ol.append(mk("li", "", `${String(h.ts).slice(0, 10)} · ${h.texto}`)); d.append(ol);
  }
  function abrirFin() { $("finTela").hidden = false; $("crmTela").hidden = true; $("rotinaTela").hidden = true; $("socialTela").hidden = true; $("finTela").querySelector(".workspace-head").after($("respostaCard")); renderFin(); }
  let filtroFin = "todos";
  const SVG = "http://www.w3.org/2000/svg";
  function graficoMeses(serie) {
    const box = $("finTendencia"); box.textContent = "";
    const W = 360, H = 150, base = 120, max = Math.max(1, ...serie.flatMap((x) => [x.receitas, x.despesas])), col = W / serie.length;
    const svg = document.createElementNS(SVG, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "fin-svg");
    const add = (tag, at, txt) => { const e = document.createElementNS(SVG, tag); for (const k in at) e.setAttribute(k, at[k]); if (txt != null) e.textContent = txt; svg.appendChild(e); return e; };
    serie.forEach((m, i) => {
      const x = i * col, atual = m.mes === mesFin, g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "fin-mes" + (atual ? " atual" : "")); g.setAttribute("tabindex", "0"); g.setAttribute("role", "button");
      g.setAttribute("aria-label", `${F.nomeMes(m.mes)}: recebido ${valor(m.receitas)}, pago ${valor(m.despesas)}`);
      const hr = Math.round((m.receitas / max) * (base - 14)), hd = Math.round((m.despesas / max) * (base - 14));
      const r = (at) => { const e = document.createElementNS(SVG, "rect"); for (const k in at) e.setAttribute(k, at[k]); g.appendChild(e); };
      r({ x: x, y: 0, width: col, height: H, class: "fin-hit" });
      r({ x: x + col * 0.17, y: base - hr, width: col * 0.31, height: Math.max(hr, m.receitas ? 2 : 0), rx: 3, class: "fin-rec" });
      r({ x: x + col * 0.52, y: base - hd, width: col * 0.31, height: Math.max(hd, m.despesas ? 2 : 0), rx: 3, class: "fin-desp" });
      const t = document.createElementNS(SVG, "text"); t.setAttribute("x", x + col / 2); t.setAttribute("y", 140); t.setAttribute("text-anchor", "middle"); t.textContent = m.rotulo; g.appendChild(t);
      const ir = () => { mesFin = m.mes; renderFin(); };
      g.addEventListener("click", ir); g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ir(); } });
      svg.appendChild(g);
    });
    add("line", { x1: 0, x2: W, y1: base, y2: base, class: "fin-eixo" });
    box.appendChild(svg);
    const lg = mk("p", "small muted fin-legenda"); lg.append(mk("span", "pt rec", "Recebido"), mk("span", "pt desp", "Pago")); box.appendChild(lg);
  }
  const variacao = (atual, antes, bomSobe) => {
    if (!antes) return null; const p = Math.round(((atual - antes) / antes) * 100); if (!p) return { txt: "igual ao mês anterior", cls: "" };
    return { txt: `${p > 0 ? "+" : ""}${p}% vs mês anterior`, cls: (p > 0) === bomSobe ? "bom" : "ruim" };
  };
  function renderFin() {
    const ls = F.lista(), r = F.resumoMes(ls, mesFin), itens = F.doMes(ls, mesFin), ant = F.resumoMes(ls, F.mesAnterior(mesFin));
    $("finMes").textContent = F.nomeMes(mesFin);
    $("finStatus").textContent = F.aviso || (F.modo === "claude" ? "Dados salvos no seu artefato Claude." : "Dados salvos neste navegador.");
    // métricas (mesmos textos de antes, agora com a variação)
    const box = $("finMetricas"); box.textContent = "";
    for (const [nome, n, v] of [["Receitas recebidas", r.receitas, variacao(r.receitas, ant.receitas, true)], ["Despesas pagas", r.despesas, variacao(r.despesas, ant.despesas, false)], ["Saldo pago", r.saldo, null], ["A pagar", r.aPagar, null], ["A receber", r.aReceber, null]]) {
      const e = mk("div", "metrica" + (nome === "Saldo pago" ? (n < 0 ? " neg" : " pos") : "")); e.append(mk("span", "", nome), mk("strong", "", valor(n)));
      if (v) e.append(mk("small", "var " + v.cls, v.txt)); box.appendChild(e);
    }
    graficoMeses(F.serieMeses(ls, mesFin, 6));
    const cats = $("finCategorias"); cats.textContent = "";
    for (const c of r.categorias) { const e = mk("div", "cat"), t = mk("div", "cat-t"); t.append(mk("span", "", c.categoria), mk("b", "", valor(c.total))); const b = mk("div", "categoria-barra"), i = mk("i"); i.style.width = Math.max(3, Math.round(c.pct * 100)) + "%"; i.style.background = F.corCategoria(c.categoria); b.append(i); e.append(t, b); cats.append(e); }
    if (!r.categorias.length) cats.append(mk("p", "muted small", "Nenhuma despesa paga neste mês."));
    // banner de fechamento
    const fech = F.fechamentoDe(mesFin), ban = $("finBanner");
    ban.hidden = !fech; if (fech) { const mudou = fech.receitas !== r.receitas || fech.despesas !== r.despesas; ban.className = "fin-banner" + (mudou ? " aviso" : ""); ban.textContent = mudou ? `Fechado em ${String(fech.fechadoEm || "").slice(0, 10)}, mas os valores mudaram depois. Atualize o fechamento.` : `Mês fechado em ${String(fech.fechadoEm || "").slice(0, 10)}.`; }
    // filtros
    const fb = $("finFiltros"); fb.textContent = "";
    for (const [id, nome] of [["todos", "Todos"], ["pagar", "A pagar"], ["receita", "Receitas"], ["despesa", "Despesas"]]) { const b = mk("button", "chip" + (filtroFin === id ? " on" : ""), nome); b.type = "button"; b.setAttribute("aria-pressed", String(filtroFin === id)); b.addEventListener("click", () => { filtroFin = id; renderFin(); }); fb.append(b); }
    const vis = itens.filter((l) => filtroFin === "todos" || (filtroFin === "pagar" ? l.status === "pendente" && l.tipo === "despesa" : l.tipo === filtroFin));
    const ul = $("finLista"); ul.textContent = "";
    for (const l of vis.sort((a, b) => b.data.localeCompare(a.data))) {
      const li = mk("li"), tx = mk("div"); tx.append(mk("strong", "", `${l.tipo === "receita" ? "+" : "−"}${valor(l.valor)} · ${l.descricao || l.categoria}`), mk("small", "", `${l.data} · ${l.categoria} · ${l.status === "pendente" ? "Pendente " + (l.vencimento || "") : "Pago/recebido"}`));
      const a = mk("div", "row");
      if (l.tipo === "despesa") {
        const sel = mk("select", "cat-sel"); sel.setAttribute("aria-label", "Categoria de " + (l.descricao || l.categoria));
        for (const c of F.CATEGORIAS.despesa) { const o = mk("option", "", c); o.value = c; if (c === l.categoria) o.selected = true; sel.append(o); }
        sel.addEventListener("change", () => F.salvar({ ...l, categoria: sel.value })); a.append(sel);
      }
      if (l.status === "pendente") { const b = mk("button", "btn", "Marcar pago"); b.type = "button"; b.addEventListener("click", () => F.salvar(F.comPago(l))); a.append(b); }
      const del = mk("button", "btn", "Apagar"); del.type = "button"; del.addEventListener("click", () => {
        if (del.dataset.armado) F.remover(l.id); else { del.dataset.armado = "1"; del.textContent = "Confirmar exclusão"; setTimeout(() => { if (del.isConnected) { del.textContent = "Apagar"; delete del.dataset.armado; } }, 4000); }
      }); a.append(del); li.append(tx, a); ul.append(li);
    }
    if (!vis.length) ul.append(mk("li", "muted", filtroFin === "todos" ? "Nenhum lançamento neste mês." : "Nenhum lançamento neste filtro."));
    // conferência
    const cf = F.conferencia(ls, mesFin, new Date(), fech), cu = $("finConferencia"); cu.textContent = "";
    for (const i of cf.itens) cu.append(mk("li", i.nivel, i.texto));
    if (cf.pronto) cu.append(mk("li", "ok", "Tudo conferido: pronto para fechar."));
    // despesas fixas
    const fu = $("finFixas"); fu.textContent = "";
    for (const f of F.fixas()) {
      const li = mk("li"), t = mk("span", "", `${f.descricao} · ${valor(f.valor)} · dia ${f.dia}`); li.append(t);
      const b = mk("button", "btn", "Remover"); b.type = "button"; b.addEventListener("click", () => F.remover(f.id)); li.append(b); fu.append(li);
    }
    if (!fu.children.length) fu.append(mk("li", "muted", "Nenhuma despesa fixa cadastrada."));
    $("finFecharMes").textContent = fech ? "Atualizar fechamento" : "Fechar o mês";
  }
  async function lancarFixasDoMes(mes) {
    const novos = F.lancarFixas(F.fixas(), F.lista(), mes); let n = 0;
    for (const l of novos) if (await F.salvar(l)) n++;
    return { novos: n, total: F.fixas().length };
  }
  function contextoClaude() {
    const modo = MODOS[modoId], ls = L.lista(), r = L.resumo(ls), mes = F.mesDe(hojeISO()), f = F.resumoMes(F.lista(), mes);
    const devidos = L.filtrar(ls, "devidos").slice(0, 5).map((l) => `${l.nome}: ${l.interesse || "sem interesse informado"}, retorno ${l.proximo}`).join("; ");
    return [window.JarvisPessoal ? JarvisPessoal.contexto() : "", `Modo: ${modo.nome}; ${modo.resumo}`, `Leads: ${r.ativos} ativos, ${r.hoje} hoje, ${r.atrasados} atrasados. Devidos: ${devidos || "nenhum"}.`,
      `Financeiro ${mes}: recebido ${valor(f.receitas)}, pago ${valor(f.despesas)}, a pagar ${valor(f.aPagar)}, a receber ${valor(f.aReceber)}.`,
      modoId === "gestao" && dados && dados.resumo ? "Dia a Dia de hoje: " + dados.resumo.itens.join("; ") + ". Agenda da clínica e e-mails NÃO estão conectados." : ""].filter(Boolean).join("\n");
  }

  // ---------- Dia a Dia (rotina) ----------
  const RT = window.JarvisRotina, P = window.JarvisPessoal;
  let rotAba = "dia", rotDia = hojeISO(), rotMes = hojeISO().slice(0, 7), rotAno = new Date().getFullYear();
  const dataExt = (d) => new Date(d + "T12:00").toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const maiusc = (x) => x.replace(/^./, (c) => c.toUpperCase());
  function abrirRotina(aba, dia) {
    if (dia) { rotDia = dia; rotMes = dia.slice(0, 7); rotAno = +dia.slice(0, 4); }
    $("rotinaTela").hidden = false; $("crmTela").hidden = true; $("finTela").hidden = true; $("socialTela").hidden = true;
    $("rotinaTela").querySelector(".workspace-head").after($("respostaCard")); if (aba) rotAba = aba; renderRotina();
  }
  function salvarPessoal(fn) { const d = P.ler(); fn(d); const ok = P.salvar(d); if (ok && window.JarvisUI) JarvisUI.render(); return ok; }
  function listaMetas(box, escopo, ref) {
    const d = RT.ler(), ul = mk("ul", "rot-lista"); box.append(mk("h2", "", escopo === "mes" ? "Metas do mês" : "Metas do ano"), ul);
    for (const m of RT.metasDe(d, escopo, ref)) {
      const li = mk("li", m.feita ? "feito" : ""), lb = mk("label"), ck = mk("input"); ck.type = "checkbox"; ck.checked = m.feita;
      ck.addEventListener("change", () => { const n = RT.ler(), i = n.metas.find((y) => y.id === m.id); if (i) i.feita = ck.checked; RT.salvar(n); });
      lb.append(ck, mk("span", "", m.texto)); const rm = mk("button", "task-delete", "×"); rm.type = "button"; rm.setAttribute("aria-label", "Remover meta " + m.texto);
      rm.addEventListener("click", () => { const n = RT.ler(); n.metas = n.metas.filter((y) => y.id !== m.id); RT.salvar(n); }); li.append(lb, rm); ul.append(li);
    }
    if (!ul.children.length) ul.append(mk("li", "muted", "Nenhuma meta definida."));
    const f = mk("form", "rot-form"), inp = mk("input"); inp.maxLength = 160; inp.placeholder = escopo === "mes" ? "Nova meta do mês" : "Nova meta do ano"; inp.setAttribute("aria-label", inp.placeholder);
    const bt = mk("button", "btn", "Adicionar"); bt.type = "submit"; f.append(inp, bt);
    f.addEventListener("submit", (e) => { e.preventDefault(); const n = RT.comMeta(RT.ler(), { texto: inp.value, escopo, ref }); if (!n.erro) RT.salvar(n); }); box.append(f);
  }
  function renderRotina() {
    if ($("rotinaTela").hidden) return;
    const agora = new Date(), hoje = hojeISO(), d = RT.ler();
    for (const [id, a] of [["rotAbaDia", "dia"], ["rotAbaSemana", "semana"], ["rotAbaMes", "mes"], ["rotAbaAno", "ano"]]) { $(id).classList.toggle("on", rotAba === a); $(id).setAttribute("aria-pressed", String(rotAba === a)); }
    for (const [id, a] of [["rotDia", "dia"], ["rotSemana", "semana"], ["rotMes", "mes"], ["rotAno", "ano"]]) $(id).hidden = rotAba !== a;
    const sem = RT.semanaDe(rotDia);
    $("rotTitulo").textContent = rotAba === "dia" ? maiusc(dataExt(rotDia)) : rotAba === "semana" ? `Semana de ${sem[0].slice(8)}/${sem[0].slice(5, 7)} a ${sem[6].slice(8)}/${sem[6].slice(5, 7)}` : rotAba === "mes" ? maiusc(RT.nomeMes(rotMes)) : String(rotAno);
    $("rotStatus").textContent = "Planeje o dia, a semana, o mês e o ano · salvo neste navegador";
    if (rotAba === "dia") {
      const c = RT.montarDia(agora, rotDia);
      $("rotResumo").textContent = RT.resumoDia({ ...c, saudacao: "" }).fala;
      if (document.activeElement !== $("rotCompData")) $("rotCompData").value = rotDia;
      $("rotPendBox").hidden = rotDia !== hoje;
      const tl = $("rotTarefas"); tl.textContent = "";
      for (const t of c.tarefas) {
        const li = mk("li", t.feita ? "feito" : ""), lb = mk("label"), ck = mk("input"); ck.type = "checkbox"; ck.checked = t.feita;
        ck.addEventListener("change", () => { salvarPessoal((x) => { const i = x.tarefas.find((y) => y.id === t.id); if (i) i.feita = ck.checked; }); renderRotina(); });
        lb.append(ck, mk("span", "", t.texto)); const rm = mk("button", "task-delete", "×"); rm.type = "button"; rm.setAttribute("aria-label", "Remover " + t.texto);
        rm.addEventListener("click", () => { salvarPessoal((x) => { x.tarefas = x.tarefas.filter((y) => y.id !== t.id); }); renderRotina(); }); li.append(lb, rm); tl.append(li);
      }
      if (!c.tarefas.length) tl.append(mk("li", "muted", rotDia === hoje ? "Nenhuma prioridade para hoje." : "Nenhuma prioridade neste dia."));
      const cl = $("rotCompromissos"); cl.textContent = "";
      for (const x of c.compromissos) {
        const li = mk("li", x.feito ? "feito" : ""), lb = mk("label"), ck = mk("input"); ck.type = "checkbox"; ck.checked = x.feito;
        ck.addEventListener("change", () => { const n = RT.ler(), i = n.compromissos.find((y) => y.id === x.id); if (i) i.feito = ck.checked; RT.salvar(n); });
        lb.append(ck, mk("span", "", (x.hora ? RT.hhmm(x.hora) + " · " : "") + x.titulo)); const rm = mk("button", "task-delete", "×"); rm.type = "button"; rm.setAttribute("aria-label", "Remover " + x.titulo);
        rm.addEventListener("click", () => { const n = RT.ler(); n.compromissos = n.compromissos.filter((y) => y.id !== x.id); RT.salvar(n); }); li.append(lb, rm); cl.append(li);
      }
      if (!c.compromissos.length) cl.append(mk("li", "muted", "Nenhum compromisso neste dia."));
      const ag = $("rotAgua"); ag.textContent = ""; ag.setAttribute("aria-label", `${c.agua} de ${c.meta} copos de água`);
      for (let i = 0; i < Math.max(c.meta, c.agua); i++) ag.append(mk("i", i < c.agua ? "cheio" : ""));
      ag.append(mk("span", "small muted", `${c.agua} de ${c.meta} copos`));
      const rf = $("rotRefeicoes"); rf.textContent = "";
      for (const r of RT.REFEICOES) { const b = mk("button", "chip" + (c.refeicoes.includes(r.id) ? " on" : ""), r.nome); b.type = "button"; b.setAttribute("aria-pressed", String(c.refeicoes.includes(r.id))); b.addEventListener("click", () => RT.salvar(RT.comRefeicao(RT.ler(), r.id, rotDia))); rf.append(b); }
      const pl = $("rotPendencias"); pl.textContent = "";
      const dev = c.retornos + c.atrasados; if (dev) { const li = mk("li"); const b = mk("button", "btn", "Abrir CRM"); b.type = "button"; b.addEventListener("click", () => abrirCrm()); li.append(mk("span", "", `${dev} retorno${dev > 1 ? "s" : ""} de leads${c.atrasados ? ` (${c.atrasados} atrasado${c.atrasados > 1 ? "s" : ""})` : ""}`), b); pl.append(li); }
      for (const x of c.contas.slice(0, 6)) pl.append(mk("li", "", `${x.descricao} · ${valor(x.valor)} · ${x.atrasada ? "atrasada" : "vence " + x.vencimento.slice(8) + "/" + x.vencimento.slice(5, 7)}`));
      if (!pl.children.length) pl.append(mk("li", "muted", "Nenhum retorno nem conta pendente."));
    } else if (rotAba === "semana") {
      const s = RT.montarSemana(agora, rotDia), box = $("rotDias"); box.textContent = "";
      for (const dia of s.dias) {
        const col = mk("button", "rot-dia" + (dia.iso === hoje ? " hoje" : "") + (dia.iso === rotDia ? " sel" : "")); col.type = "button"; col.setAttribute("aria-label", "Abrir " + dataExt(dia.iso)); col.append(mk("strong", "", `${dia.rotulo} ${dia.iso.slice(8)}`));
        for (const x of dia.compromissos.slice(0, 4)) col.append(mk("span", x.feito ? "feito" : "", `${x.hora ? RT.hhmm(x.hora) + " " : ""}${x.titulo}`));
        if (dia.tarefasTotal) col.append(mk("small", "muted", `${dia.tarefasFeitas}/${dia.tarefasTotal} prioridades`));
        if (!dia.compromissos.length && !dia.tarefasTotal) col.append(mk("small", "muted", "livre"));
        col.addEventListener("click", () => { rotDia = dia.iso; rotAba = "dia"; renderRotina(); }); box.append(col);
      }
      const fb = RT.feedbackSemana(s), ul = $("rotFeedback"); ul.textContent = "";
      for (const i of fb.itens) ul.append(mk("li", i.nivel === "atencao" ? "alerta" : i.nivel === "bom" ? "ok" : "info", i.texto));
    } else if (rotAba === "mes") {
      const r = RT.montarMes(agora, rotMes), box = $("rotMes"); box.textContent = "";
      const grade = mk("div", "rot-mes-grade"); for (const n of ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]) grade.append(mk("span", "rot-cab", n));
      const mapa = new Map(r.dias.map((x) => [x.dia, x]));
      for (const dia of RT.diasDoMes(rotMes)) {
        if (!dia) { grade.append(mk("span", "rot-vazio")); continue; } const x = mapa.get(dia);
        const b = mk("button", "rot-cel" + (dia === hoje ? " hoje" : "") + (x.c || x.t ? " tem" : "")); b.type = "button"; b.setAttribute("aria-label", `${dataExt(dia)}: ${x.c} compromissos, ${x.t} prioridades`);
        b.append(mk("b", "", String(+dia.slice(8)))); const pt = mk("span", "pts"); for (let i = 0; i < Math.min(x.c, 3); i++) pt.append(mk("i", "c")); for (let i = 0; i < Math.min(x.t, 3); i++) pt.append(mk("i", "t")); b.append(pt);
        b.addEventListener("click", () => { rotDia = dia; rotAba = "dia"; renderRotina(); }); grade.append(b);
      }
      box.append(grade); const resumo = mk("section", "fin-painel"); resumo.append(mk("h2", "", "Como está o mês")); const ul = mk("ul", "fin-conferencia"); for (const i of r.itens) ul.append(mk("li", i.nivel === "bom" ? "ok" : "info", i.texto)); resumo.append(ul);
      const metas = mk("section", "fin-painel"); listaMetas(metas, "mes", rotMes); const duo = mk("div", "rot-grid"); duo.append(resumo, metas); box.append(duo);
    } else {
      const r = RT.montarAno(agora, rotAno), box = $("rotAno"); box.textContent = "";
      const grade = mk("div", "rot-ano-grade");
      for (const m of r.meses) {
        const b = mk("button", "rot-mes-card" + (m.mes === hoje.slice(0, 7) ? " hoje" : "")); b.type = "button"; b.setAttribute("aria-label", `${RT.nomeMes(m.mes)}: ${m.c} compromissos`);
        b.append(mk("strong", "", maiusc(m.rotulo)), mk("span", "", `${m.c} compromisso${m.c === 1 ? "" : "s"}`), mk("small", "muted", m.t ? `${m.feitas}/${m.t} prioridades` : "sem prioridades"), m.metas ? mk("small", "", `${m.metas} meta${m.metas > 1 ? "s" : ""}`) : mk("small", "muted", "—"));
        b.addEventListener("click", () => { rotMes = m.mes; rotAba = "mes"; renderRotina(); }); grade.append(b);
      }
      const metas = mk("section", "fin-painel"); listaMetas(metas, "ano", String(rotAno)); box.append(grade, metas);
    }
  }
  RT.aoMudar(renderRotina); L.aoMudar(renderRotina); F.aoMudar(renderRotina);
  window.JarvisRotinaUI = { abrir: abrirRotina };
  async function comandoRot(it, g) {
    const agora = new Date(), hoje = hojeISO(), h = agora.getHours();
    if (it.tipo === "rot_dia") {
      const amanha = it.quando === "amanha", dia = it.data || (amanha ? L.somar(hoje, 1) : hoje), c = RT.montarDia(agora, dia), r = RT.resumoDia({ ...c, saudacao: it.saudacao ? c.saudacao : "" });
      if (it.saudacao) mostrarCard("Seu dia", r.itens); else { abrirRotina("dia", dia); mostrarCard(dia === hoje ? "Seu dia" : maiusc(dataExt(dia)), r.itens); }
      return dizer(r.fala, g);
    }
    if (it.tipo === "rot_semana") {
      abrirRotina("semana"); const f = RT.feedbackSemana(RT.montarSemana(agora, rotDia)); mostrarCard("Feedback da semana", f.itens.map((x) => x.texto)); return dizer(f.fala, g);
    }
    if (it.tipo === "rot_mes") {
      rotMes = it.seguinte ? RT.somarMes(hoje.slice(0, 7), 1) : hoje.slice(0, 7); abrirRotina("mes"); const r = RT.montarMes(agora, rotMes);
      mostrarCard(maiusc(RT.nomeMes(rotMes)), r.itens.map((x) => x.texto)); return dizer(r.fala, g);
    }
    if (it.tipo === "rot_ano") {
      rotAno = new Date().getFullYear() + (it.seguinte ? 1 : 0); abrirRotina("ano"); const r = RT.montarAno(agora, rotAno);
      mostrarCard(String(rotAno), r.meses.filter((m) => m.c || m.t || m.metas).map((m) => `${maiusc(m.rotulo)}: ${m.c} compromisso${m.c === 1 ? "" : "s"}${m.t ? `, ${m.feitas}/${m.t} prioridades` : ""}`).concat(r.metas.map((m) => "Meta: " + m.texto)));
      return dizer(r.fala, g);
    }
    if (it.tipo === "rot_meta") {
      const ref = it.escopo === "mes" ? hoje.slice(0, 7) : String(new Date().getFullYear()), n = RT.comMeta(RT.ler(), { texto: it.meta, escopo: it.escopo, ref });
      if (n.erro || !RT.salvar(n)) return dizer("Não consegui anotar a meta.", g); return dizer(`Anotei a meta ${it.escopo === "mes" ? "do mês" : "do ano"}: ${it.meta}.`, g);
    }
    if (it.tipo === "rot_abrir") { abrirRotina(); return dizer("Abri o seu Dia a Dia.", g); }
    if (it.tipo === "rot_agua" || it.tipo === "rot_agua_status") {
      const n = it.tipo === "rot_agua" ? it.n : 0, d = n ? RT.comAgua(RT.ler(), n, hoje) : RT.ler(); if (n && !RT.salvar(d)) return dizer("Não consegui salvar agora.", g);
      const tot = RT.agua(d, hoje), meta = d.metaAgua;
      return dizer(n ? `Anotei ${n} copo${n > 1 ? "s" : ""}. Hoje: ${tot} de ${meta}${tot >= meta ? ". Meta batida, parabéns!" : "."}` : `Hoje você bebeu ${tot} de ${meta} copos de água.`, g);
    }
    if (it.tipo === "rot_refeicao") {
      const id = it.refeicao || (h < 10 ? "cafe" : h < 15 ? "almoco" : h < 18 ? "lanche" : "jantar"), nome = RT.REFEICOES.find((x) => x.id === id).nome.toLowerCase();
      if (!RT.salvar(RT.comRefeicao(RT.ler(), id, hoje, true))) return dizer("Não consegui salvar agora.", g);
      return dizer(`Anotei: ${nome}.`, g);
    }
    if (it.tipo === "rot_tarefa") {
      if (!it.tarefa) return dizer("Qual é a tarefa?", g); const dia = it.dia || hoje;
      if (!salvarPessoal((x) => { x.tarefas.push({ id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), texto: it.tarefa, dia, feita: false }); })) return dizer("Não consegui salvar a tarefa.", g);
      return dizer(`Anotei a prioridade: ${it.tarefa}${dia === hoje ? "" : ", para " + dataExt(dia)}.`, g);
    }
    if (it.tipo === "rot_tarefa_feita") {
      const ach = P.ler().tarefas.filter((t) => !t.feita && JarvisBrain.norm(t.texto).includes(it.nome));
      if (ach.length !== 1) return dizer(ach.length ? "Achei mais de uma prioridade com esse nome. Abra o Dia a Dia e marque a certa." : "Não achei essa prioridade pendente.", g);
      salvarPessoal((x) => { const i = x.tarefas.find((y) => y.id === ach[0].id); if (i) i.feita = true; }); return dizer(`Marquei como concluída: ${ach[0].texto}.`, g);
    }
    if (it.tipo === "rot_compromisso") {
      const c = RT.novoCompromisso({ titulo: it.titulo, data: it.data, hora: it.hora }, agora); if (c.erro) return dizer("Qual é o compromisso?", g);
      const d = RT.ler(); d.compromissos.push(c); if (!RT.salvar(d)) return dizer("Não consegui salvar o compromisso.", g);
      return dizer(`Marquei ${c.titulo} para ${c.data === hoje ? "hoje" : dataExt(c.data)}${c.hora ? ", às " + RT.hhmm(c.hora) : ""}.`, g);
    }
  }

  // ---------- Social Media (comentários, calendário, métricas) e central de avisos ----------
  const SC = window.JarvisSocial, AV = window.JarvisAvisos;
  const curto = (d) => d.slice(8) + "/" + d.slice(5, 7);
  function abrirSocial() {
    $("socialTela").hidden = false; $("crmTela").hidden = true; $("finTela").hidden = true; $("rotinaTela").hidden = true;
    $("socialTela").querySelector(".workspace-head").after($("respostaCard")); renderSocial();
  }
  function respostasPara(c) { mostrarCard(`Respostas para @${c.autor}`, SC.respostasLocais(c)); }
  async function respostasClaude(c) {
    setEstado("pensando");
    const r = await JarvisBrain.perguntarClaude({ modo: MODOS.social, texto: `Escreva 3 respostas curtas e acolhedoras, em português do Brasil, para este comentário no Instagram de uma clínica odontológica: "${c.texto}" (de @${c.autor}). Sem preço, sem promessa de resultado, convidando a continuar no direct. Cada item do campo "itens" é uma resposta pronta.`, contexto: contextoClaude(), historico: [] });
    setEstado("idle");
    if (!r || r.erro || !r.itens.length) { mostrarCard(`Respostas para @${c.autor}`, SC.respostasLocais(c)); return false; }
    mostrarCard(`Respostas para @${c.autor} (Claude)`, r.itens); return true;
  }
  function renderSocial() {
    if ($("socialTela").hidden) return;
    const d = SC.ler(), hoje = hojeISO(), pend = SC.pendentes(d);
    $("socStatus").textContent = `${pend.length} comentário${pend.length === 1 ? "" : "s"} a responder · ${SC.postsDoDia(d, hoje).length} post(s) hoje · salvo neste navegador`;
    const cl = $("socComentarios"); cl.textContent = "";
    for (const c of pend) {
      const li = mk("li"), tx = mk("div"); tx.append(mk("strong", "", "@" + c.autor), mk("small", "", c.texto));
      const a = mk("div", "row");
      const b1 = mk("button", "btn", "Sugerir resposta"); b1.type = "button"; b1.addEventListener("click", () => respostasPara(c));
      const b2 = mk("button", "btn", "Com Claude"); b2.type = "button"; b2.addEventListener("click", () => respostasClaude(c));
      const b3 = mk("button", "btn", "Respondido"); b3.type = "button"; b3.addEventListener("click", () => { const n = SC.ler(), i = n.comentarios.find((x) => x.id === c.id); if (i) i.status = "respondido"; SC.salvar(n); });
      const rm = mk("button", "task-delete", "×"); rm.type = "button"; rm.setAttribute("aria-label", "Remover comentário de " + c.autor); rm.addEventListener("click", () => { const n = SC.ler(); n.comentarios = n.comentarios.filter((x) => x.id !== c.id); SC.salvar(n); });
      a.append(b1, b2, b3, rm); li.append(tx, a); cl.append(li);
    }
    if (!pend.length) cl.append(mk("li", "muted", "Nenhum comentário esperando resposta."));
    const pl = $("socPosts"); pl.textContent = "";
    for (const p of d.posts.filter((x) => x.status !== "postado" || x.data >= hoje).sort((a, b) => a.data.localeCompare(b.data)).slice(0, 14)) {
      const li = mk("li", p.status === "postado" ? "feito" : ""), tx = mk("span", "", `${curto(p.data)}${p.data < hoje && p.status !== "postado" ? " (atrasado)" : ""} · ${p.formato} · ${p.tema}`);
      const sel = mk("select", "cat-sel"); sel.setAttribute("aria-label", "Status de " + p.tema);
      for (const [v, n] of SC.STATUS) { const o = mk("option", "", n); o.value = v; if (v === p.status) o.selected = true; sel.append(o); }
      sel.addEventListener("change", () => { const n = SC.ler(), i = n.posts.find((x) => x.id === p.id); if (i) i.status = sel.value; SC.salvar(n); });
      const rm = mk("button", "task-delete", "×"); rm.type = "button"; rm.setAttribute("aria-label", "Remover post " + p.tema); rm.addEventListener("click", () => { const n = SC.ler(); n.posts = n.posts.filter((x) => x.id !== p.id); SC.salvar(n); });
      const a = mk("div", "row"); a.append(sel, rm); li.append(tx, a); pl.append(li);
    }
    if (!pl.children.length) pl.append(mk("li", "muted", "Nenhum post planejado."));
    const tl = $("socTop"); tl.textContent = "";
    for (const m of SC.melhores(d.metricas, 5)) tl.append(mk("li", "", `${m.titulo} · alcance ${m.alcance} · ${m.curtidas} curtidas · ${m.comentarios} comentários · ${m.salvos} salvos`));
    if (!d.metricas.length) tl.append(mk("li", "muted", "Nenhuma métrica importada ainda."));
  }
  SC.aoMudar(renderSocial);
  async function comandoSoc(it, g) {
    const hoje = hojeISO(), d = SC.ler();
    if (it.tipo === "soc_abrir") { abrirSocial(); return dizer("Abri o Social Media.", g); }
    if (it.tipo === "soc_instagram") {
      abrirSocial(); const r = SC.resumo(d, hoje, L.somar(hoje, 6)), top = SC.melhores(d.metricas, 1)[0];
      mostrarCard("Instagram", [`Comentários a responder: ${r.pendentes}`, `Posts hoje: ${r.hoje} · atrasados: ${r.atrasados} · na semana: ${r.semana}`, top ? `Melhor post importado: ${top.titulo}` : "Nenhuma métrica importada", "Conexão ao vivo: não conectada (exige servidor)"]);
      return dizer(`Ainda não consigo ver seu Instagram ao vivo, porque a conexão oficial exige um servidor. Pelo que você registrou: ${r.pendentes} comentário${r.pendentes === 1 ? "" : "s"} para responder e ${r.hoje} post${r.hoje === 1 ? "" : "s"} para hoje. Para métricas, importe o CSV do Meta Business Suite.`, g);
    }
    if (it.tipo === "soc_comentario") {
      const c = SC.novoComentario({ autor: it.autor, texto: it.comentario }); if (c.erro) return dizer("Qual foi o comentário?", g);
      d.comentarios.push(c); if (!SC.salvar(d)) return dizer("Não consegui salvar agora.", g);
      respostasPara(c); return dizer(`Anotei o comentário de ${c.autor}. Já deixei 3 respostas sugeridas na tela.`, g);
    }
    if (it.tipo === "soc_comentarios") {
      const p = SC.pendentes(d); abrirSocial();
      mostrarCard("Comentários a responder", p.map((c) => `@${c.autor}: ${c.texto}`));
      return dizer(p.length ? `Você tem ${p.length} comentário${p.length === 1 ? "" : "s"} para responder. O mais antigo é de ${p[0].autor}.` : "Nenhum comentário esperando resposta.", g);
    }
    if (it.tipo === "soc_responder" || it.tipo === "soc_respondido") {
      const ach = SC.achar(d, it.autor); if (ach.length !== 1) return dizer(ach.length ? "Achei mais de um comentário desse nome. Abra o Social Media e escolha." : `Não achei comentário pendente de ${it.autor}.`, g);
      if (it.tipo === "soc_responder") { respostasPara(ach[0]); return dizer(`Montei 3 opções de resposta para ${ach[0].autor}. Estão na tela para copiar.`, g); }
      const i = d.comentarios.find((x) => x.id === ach[0].id); i.status = "respondido"; SC.salvar(d); return dizer(`Marquei o comentário de ${ach[0].autor} como respondido.`, g);
    }
    if (it.tipo === "soc_post") {
      const p = SC.novoPost({ tema: it.tema, data: it.data, formato: it.formato }, hoje); if (p.erro) return dizer("Qual é o tema do post?", g);
      d.posts.push(p); if (!SC.salvar(d)) return dizer("Não consegui salvar agora.", g);
      return dizer(`Planejei um ${p.formato.toLowerCase()} sobre ${p.tema.toLowerCase()} para ${p.data === hoje ? "hoje" : curto(p.data)}.`, g);
    }
    if (it.tipo === "soc_posts") {
      const fut = d.posts.filter((p) => p.status !== "postado").sort((a, b) => a.data.localeCompare(b.data)).slice(0, 8); abrirSocial();
      mostrarCard("Calendário de posts", fut.map((p) => `${curto(p.data)} · ${p.formato} · ${p.tema}${p.data < hoje ? " (atrasado)" : ""}`));
      const h = SC.postsDoDia(d, hoje).length; return dizer(fut.length ? `Você tem ${fut.length} post${fut.length === 1 ? "" : "s"} planejado${fut.length === 1 ? "" : "s"}, ${h ? h + " para hoje" : "nenhum para hoje"}.` : "Nenhum post planejado. Diga, por exemplo: agenda um reels sobre clareamento sexta.", g);
    }
  }
  function avisosAgora() { const c = AV.coletar(new Date()); return { ...AV.montar(c), _c: c }; }
  async function comandoAvisos(it, g) {
    if (it.tipo === "avisos_crc") {
      const c = AV.coletar(new Date()), ps = c._parados;
      mostrarCard("Clientes para reativar", ps.slice(0, 8).map((l) => `${l.nome} · último contato ${l.ultimoContato || String(l.atualizado || "").slice(0, 10) || "sem registro"}`), ps.slice(0, 2).map((l) => "manda mensagem pro " + l.nome));
      return dizer(ps.length ? `${ps.length} cliente${ps.length === 1 ? " fechado está" : "s fechados estão"} sem contato há mais de 30 dias. Quer chamar ${ps[0].nome.split(" ")[0]}? Diga: manda mensagem pro ${ps[0].nome.split(" ")[0]}.` : "Nenhum cliente fechado está parado há mais de 30 dias.", g);
    }
    const a = avisosAgora(); mostrarCard("Avisos e pendências", a.itens.map((x) => x.texto), [...new Set(a.itens.map((x) => x.cmd))].slice(0, 4));
    return dizer(a.fala, g);
  }
  // Proatividade: ao abrir e a cada 10 minutos, mostra (sem falar sozinho) o que mudou de importante.
  let assinaturaAvisos = "";
  function vigiarAvisos(primeira) {
    try {
      const a = avisosAgora(), imp = a.itens.filter((x) => x.nivel !== "info"), sig = imp.map((x) => x.texto).join("|");
      if (!imp.length || sig === assinaturaAvisos || estado === "falando" || estado === "ouvindo" || estado === "pensando") return; assinaturaAvisos = sig;
      if (document.body.dataset.dock) return;                     // com uma função aberta, não atrapalha
      legenda(primeira ? a.fala : "Novo aviso: " + imp[0].texto + ".", true); mostrarCard("Para agora", a.itens.map((x) => x.texto), [...new Set(a.itens.map((x) => x.cmd))].slice(0, 3));
      avatar.impulso(1); sfx("ativar");
    } catch (_) {}
  }
  async function comandoFin(it, g) {
    if (it.tipo === "fin_lancar") {
      if (it.erro === "valor") { aguardando = { tipo: "fin_valor", lanc: it.lanc }; return dizer("Qual o valor em reais?", g); }
      const lanc = F.novo(it.lanc); if (lanc.erro) return dizer("Não entendi o valor. Informe um valor maior que zero.", g);
      if (!(await F.salvar(lanc))) return dizer(F.aviso || "Não consegui salvar.", g);
      abrirFin(); return dizer(`Lancei ${lanc.tipo === "receita" ? "receita" : "despesa"} de ${valor(lanc.valor)} como ${lanc.status}.`, g);
    }
    if (it.tipo === "fin_resumo") {
      mesFin = it.mes || F.mesDe(hojeISO()); abrirFin(); const r = F.resumoMes(F.lista(), mesFin);
      mostrarCard(`Resumo de ${F.nomeMes(mesFin)}`, [`Recebido: ${valor(r.receitas)}`, `Pago: ${valor(r.despesas)}`, `Saldo pago: ${valor(r.saldo)}`, `A pagar: ${valor(r.aPagar)}`, `A receber: ${valor(r.aReceber)}`]);
      return dizer(`Mostrei o resumo de ${F.nomeMes(mesFin)} na tela.`, g);
    }
    if (it.tipo === "fin_pendentes") {
      const lista = F.pendentes(F.lista(), new Date(), 7); abrirFin();
      mostrarCard("Contas pendentes", lista.length ? lista.slice(0, 8).map((x) => `${x.descricao || x.categoria}: ${valor(x.valor)}, vence ${x.vencimento || x.data}${x.atrasada ? " (atrasada)" : ""}`) : ["Nenhuma conta vencida ou a vencer nos próximos 7 dias."]);
      return dizer(`Você tem ${lista.length} conta${lista.length === 1 ? "" : "s"} pendente${lista.length === 1 ? "" : "s"} na próxima semana. Mostrei na tela.`, g);
    }
    if (it.tipo === "fin_pagar") {
      const q = JarvisBrain.norm(it.nome), achados = F.lista().filter((l) => l.tipo === "despesa" && l.status === "pendente" && JarvisBrain.norm(l.descricao || l.categoria).includes(q));
      if (achados.length !== 1) return dizer(achados.length ? "Achei mais de uma conta. Abra o Contador e escolha qual marcar como paga." : "Não achei essa conta pendente. Abra o Contador para conferir.", g);
      if (!(await F.salvar(F.comPago(achados[0])))) return dizer(F.aviso || "Não consegui salvar.", g);
      abrirFin(); return dizer(`Marquei ${achados[0].descricao || achados[0].categoria} como paga.`, g);
    }
    if (it.tipo === "fin_fixas") {
      mesFin = it.mes || F.mesDe(hojeISO()); const r = await lancarFixasDoMes(mesFin); abrirFin();
      if (!r.total) return dizer("Você ainda não cadastrou despesas fixas. Diga, por exemplo: cadastra despesa fixa aluguel 2800 dia 5.", g);
      return dizer(r.novos ? `Lancei ${r.novos} despesa${r.novos > 1 ? "s fixas" : " fixa"} em ${F.nomeMes(mesFin)}, como pendentes.` : `As fixas de ${F.nomeMes(mesFin)} já estavam lançadas.`, g);
    }
    if (it.tipo === "fin_fixa_nova") {
      if (it.erro) return dizer("Qual o valor da despesa fixa? Diga, por exemplo: cadastra despesa fixa aluguel 2800 dia 5.", g);
      const f = F.novaFixa(it.fixa); if (f.erro) return dizer(f.erro === "valor" ? "Não entendi o valor." : "Qual o nome da despesa fixa?", g);
      if (!(await F.salvar(f))) return dizer(F.aviso || "Não consegui salvar.", g);
      abrirFin(); return dizer(`Cadastrei ${f.descricao}, ${valor(f.valor)}, todo dia ${f.dia}. Diga "lança as fixas do mês" para criar os lançamentos.`, g);
    }
    if (it.tipo === "fin_fechar") {
      mesFin = it.mes || F.mesDe(hojeISO()); if (!(await F.fecharMes(mesFin))) return dizer(F.aviso || "Não consegui fechar o mês.", g);
      abrirFin(); return dizer(`Registrei o fechamento de ${F.nomeMes(mesFin)}. O relatório está disponível para copiar.`, g);
    }
  }

  // ---------- estado visual ----------
  function setEstado(e) {
    estado = e; avatar.setEstado(e); document.documentElement.dataset.estado = e;
    document.querySelectorAll("#estados li").forEach((li) => li.classList.toggle("on", li.dataset.estado === e));
  }
  // A legenda "digita" no ritmo da fala; o leitor de tela recebe o texto inteiro de uma vez.
  const reduzido = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let digitacao = 0;
  function legenda(t, animar) {
    const el = $("legenda"), texto = t || "";
    clearInterval(digitacao); $("legendaSr").textContent = texto;
    if (!animar || reduzido || texto.length < 12) { el.textContent = texto; el.classList.remove("digitando"); return; }
    const total = Math.min(650, 160 + texto.length * 4), passo = Math.max(12, Math.min(30, total / texto.length));   // a resposta aparece quase na hora; a voz continua no ritmo dela
    let i = 0; el.classList.add("digitando");
    digitacao = setInterval(() => {
      i += Math.max(1, Math.round(texto.length / (total / passo) ));
      el.textContent = texto.slice(0, i);
      if (i >= texto.length) { clearInterval(digitacao); el.classList.remove("digitando"); }
    }, passo);
  }
  async function dizer(texto, g) {
    legenda(texto, true); registrarConversa("jarvis", texto); setEstado("falando"); avatar.impulso(.8);
    await JarvisVoice.falar(texto);
    if (g === geracao) setEstado(JarvisVoice.escutando ? "ouvindo" : "idle");
  }

  // ---------- render de painéis ----------
  function renderChips() {
    const nav = $("chips"); nav.textContent = "";
    for (const id of JARVIS_ORDEM) {
      const m = MODOS[id], b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.dataset.modo = id; b.style.setProperty("--c", m.cor);
      b.append(mk("span", "mode-index", String(JARVIS_ORDEM.indexOf(id) + 1).padStart(2, "0")), mk("strong", "", m.nome), mk("span", "mode-desc", m.resumo));
      if (m.status === "demo") b.append(mk("span", "mode-state", "Dados demo"));
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
    avatar.setCor(m.cor); fundo.setCor(m.cor);
    $("agNome").textContent = m.nome;
    const st = $("agStatus"); st.textContent = m.status; st.className = "tag " + m.status;
    $("agResumo").textContent = m.resumo;
    const dl = $("kpis"); dl.textContent = "";
    for (const [k, v] of m.kpis(dados)) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k; dd.textContent = v; dl.append(dt, dd); contar(dd, v);
    }
    renderSpark(dados.serie);
    const ul = $("ferramentas"); ul.textContent = "";
    for (const f of m.ferramentas) {
      const li = document.createElement("li"), n = document.createElement("b");
      n.className = "n " + f.nivel; n.textContent = f.nivel; li.append(n, " " + f.desc); li.title = f.id; ul.appendChild(li);
    }
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.modo === modoId));
    const badge = $("badgeFonte"), src = dados.source;
    badge.hidden = modoId === "normal";
    badge.textContent = src === "live" ? "AO VIVO" : src === "seus" ? "SEUS DADOS" : src === "misto" ? "DEMO + SUAS CONTAS" : src === "criacao" ? "RASCUNHOS" : "DEMO"; badge.className = "badge " + (src === "demo" || src === "misto" ? "demo" : "live");
    $("cerebro").textContent = "Você decide o que executar.";
    renderSugestoes();
  }
  // Números que sobem até o valor (só quando o valor é um número simples, em R$ ou não).
  function contar(el, texto) {
    const m = String(texto).match(/^(R\$ )?(\d+(?:[.,]\d+)?)$/);
    if (!m || reduzido) return;
    const dec = (m[2].split(/[.,]/)[1] || "").length, alvo = parseFloat(m[2].replace(",", ".")), t0 = performance.now();
    const fmt = (v) => (m[1] || "") + v.toFixed(dec).replace(".", ",");
    el.textContent = fmt(0);
    (function passo(now) {
      const p = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(alvo * e);
      if (p < 1) requestAnimationFrame(passo); else el.textContent = texto;
    })(t0);
  }
  // Mini gráfico de tendência (SVG), com linha que se desenha e ponto final.
  function renderSpark(serie) {
    const fig = $("spark"); fig.hidden = !serie;
    if (!serie) return;
    $("sparkRotulo").textContent = serie.rotulo;
    const v = serie.valores, W = 220, H = 64, pad = 6, min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
    const pt = v.map((y, i) => [pad + (i / (v.length - 1)) * (W - 2 * pad), H - pad - ((y - min) / span) * (H - 2 * pad)]);
    const d = pt.map((q, i) => (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" ");
    const svg = $("sparkSvg"), NS = "http://www.w3.org/2000/svg"; svg.textContent = "";
    const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
    const defs = mk("defs", {}), lg = document.createElementNS(NS, "linearGradient");
    lg.setAttribute("id", "sparkGrad"); lg.setAttribute("x1", "0"); lg.setAttribute("y1", "0"); lg.setAttribute("x2", "0"); lg.setAttribute("y2", "1");
    for (const [o, a] of [["0", ".35"], ["1", "0"]]) { const st = document.createElementNS(NS, "stop"); st.setAttribute("offset", o); st.setAttribute("stop-color", "var(--accent)"); st.setAttribute("stop-opacity", a); lg.appendChild(st); }
    defs.appendChild(lg);
    mk("line", { class: "grade", x1: pad, x2: W - pad, y1: H - pad, y2: H - pad });
    mk("path", { class: "area", d: d + ` L ${pt[pt.length - 1][0]} ${H - pad} L ${pt[0][0]} ${H - pad} Z` });
    const linha = mk("path", { class: "linha", d }); linha.style.setProperty("--len", "600");
    const u = pt[pt.length - 1]; mk("circle", { class: "ponta", cx: u[0], cy: u[1], r: 3.2 });
  }
  function entrada(sel) {   // reaplica a animação de entrada, em sequência
    if (reduzido) return;
    document.querySelectorAll(sel).forEach((el, i) => { el.classList.remove("entra"); void el.offsetWidth; el.style.animationDelay = (i * 70) + "ms"; el.classList.add("entra"); });
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
    if (window.JarvisUI) JarvisUI.focarJarvis();
    modoId = id; pendente = null; aguardando = null; renderPendente();
    dados = id === "normal" ? {} : await JarvisData.get(id);
    if (g !== geracao) return;
    if (id === "leads") { $("painelLeads").open = true; renderLeads(); }
    if (id === "contador") abrirFin(); else if (id === "gestao") abrirRotina("dia"); else if (id === "social") abrirSocial(); else fecharAreas();
    renderModo(); sfx("ativar"); entrada(".col.left > .panel:not([hidden]), .sugestoes .sug");
    gravarLog({ tipo: "ativar", fonte: dados.source });
    await dizer((prefixo ? prefixo + " " : "") + MODOS[id].abertura(dados), g);
  }

  // Monta a ação "abrir WhatsApp com a mensagem pronta" (precisa do seu confirma).
  async function prepararMensagem(contato, msg, g) {
    if (!msg) { aguardando = { tipo: "texto", contato }; return dizer(`O que eu digo para ${contato.nome}?`, g); }
    const url = JarvisBrain.linkWhatsapp(contato.tel, msg);
    if (!url) { $("painelContatos").open = true; return dizer(`O telefone de ${contato.nome} parece inválido. Corrija no painel de contatos.`, g); }
    definirPendente({ id: "whatsapp.abrir", nivel: "EXECUTE", titulo: `Abrir WhatsApp de ${contato.nome}`, detalhe: [`${contato.nome} · ${contato.tel}`], exemplo: msg, url });
    return dizer(`Preparei a mensagem para ${contato.nome}. Confira o texto na tela e diga confirma para abrir o WhatsApp.`, g);
  }
  async function continuarAguardando(texto, g) {
    const a = aguardando; aguardando = null;
    if (a.tipo === "fin_valor") {
      const n = F.lerValor(texto);
      if (!(n > 0)) { aguardando = a; return dizer("Não entendi o valor. Diga, por exemplo, cento e cinquenta reais ou 150.", g); }
      return comandoFin({ tipo: "fin_lancar", lanc: { ...a.lanc, valor: n } }, g);
    }
    if (a.tipo === "lead_tel") return criarLeadComDados({ ...a.dados, tel: texto }, g);
    if (a.tipo === "lead_escolha") {
      const r = JarvisBrain.acharContato(texto, a.opcoes);
      if (r.length !== 1) { aguardando = a; return dizer(`Não entendi qual. Diga o nome completo: ${a.opcoes.map((c) => c.nome).join(", ")}.`, g); }
      return a.depois(r[0], g);
    }
    if (a.tipo === "lead_data") {
      const d = L.dataDe(texto);
      if (!d) { aguardando = a; return dizer("Não entendi a data. Diga amanhã, sexta, daqui a 3 dias ou dia 20.", g); }
      return aplicarData(d)(a.lead, g);
    }
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
    if (window.JarvisUI) JarvisUI.focarJarvis();
    limparCard();
    acordadoAte = Date.now() + 12000; sfx("enviar"); avatar.impulso(1);
    registrarConversa("voce", texto.trim());
    gravarLog({ tipo: it.tipo, entrada: texto, fonte: origem });

    // Meio de um pedido (falta o texto ou a escolha do contato): a próxima frase
    // é a resposta, a não ser que seja um comando de verdade.
    if (aguardando) {
      const comando = ["sair", "cancelar", "ativar", "confirmar"].includes(it.tipo) || (aguardando.tipo === "texto" && it.tipo === "mensagem")
        || (it.tipo.startsWith("lead_") && !it.solto);
      if (!comando) return continuarAguardando(texto, g);
      if (it.tipo === "cancelar") { aguardando = null; return dizer("Cancelado.", g); }
      if (it.tipo !== "confirmar") aguardando = null;
    }

    if (it.tipo.startsWith("lead_")) {
      const r = await comandoLead(it, g);
      if (r !== NAO_LEAD) return r;
    }
    if (it.tipo === "crm_abrir") { abrirCrm(); return dizer("Abri o CRM. Mostrei as etapas e os retornos na tela.", g); }
    if (it.tipo === "crm_fechar") { fecharAreas(); return dizer("Fechei o CRM.", g); }
    if (it.tipo.startsWith("fin_")) return comandoFin(it, g);
    if (it.tipo.startsWith("rot_")) return comandoRot(it, g);
    if (it.tipo.startsWith("soc_")) return comandoSoc(it, g);
    if (it.tipo.startsWith("avisos_")) return comandoAvisos(it, g);
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
        const a = $("linkWa"); a.classList.remove("pulsa"); void a.offsetWidth; a.classList.add("pulsa");
        return dizer("Toque em Abrir WhatsApp. A mensagem está pronta e você decide se envia.", g);
      }
      pendente = null; renderPendente();
      gravarLog({ tipo: "executar", entrada: p.id, fonte: dados.source });
      return dizer(`Confirmação registrada para ${p.titulo}. Nenhum envio externo foi feito.`, g);
    }
    if (/\b(paciente|pacientes|confirmac\w*|clinicorp)\b/.test(it.texto)) { gravarLog({ tipo: "resposta", fonte: "local" }); return dizer("A agenda da clínica ainda não está conectada ao Jarvis. Por enquanto organizo seus compromissos aqui: diga, por exemplo, “marca consulta amanhã às 9h”.", g); }
    if (/\b(e mail|email|gmail)\b/.test(it.texto)) { gravarLog({ tipo: "resposta", fonte: "local" }); return dizer("Seus e-mails ainda não estão conectados ao Jarvis. Quando estiverem, eu separo o que pede resposta e os boletos.", g); }
    // pergunta aberta
    setEstado("pensando"); legenda("…");
    const r = await JarvisBrain.perguntarClaude({ modo: MODOS[modoId], texto, contexto: contextoClaude(), historico: conversa.slice(-4) });
    if (g !== geracao) return;
    if (!r || r.erro) {
      const msg = !r || r.erro === "indisponivel" ? "O Claude não está disponível aqui. Posso usar os comandos de leads e financeiro; para perguntas abertas, abra o artefato no Claude e permita o acesso quando for solicitado."
        : r.erro === "limite" ? "O limite de perguntas ao Claude foi atingido. Tente mais tarde." : "Não consegui consultar o Claude agora. Tente novamente.";
      gravarLog({ tipo: "resposta", fonte: "indisponivel" }); return dizer(msg, g);
    }
    if (r.titulo || r.itens.length) mostrarCard(r.titulo, r.itens, r.acoes);
    gravarLog({ tipo: "resposta", fonte: "claude" });
    return dizer(r.fala, g);
  }
  // Nenhum erro deixa o Jarvis preso em "pensando".
  async function processar(texto, origem) {
    try { return await processarInterno(texto, origem); }
    catch (e) {
      console.error(e); setEstado("idle"); sfx("erro");
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
  $("linkWa").addEventListener("click", (e) => {      // abrir não prova envio; retorno só após registro manual
    const p = pendente; if (!p || expirada()) { e.preventDefault(); pendente = null; renderPendente(); legenda("Essa ação expirou. Peça novamente."); return; }
    const gExec = geracao;
    setEstado("executando");
    setTimeout(() => { if (geracao === gExec && estado === "executando") setEstado("idle"); }, 700);
    gravarLog({ tipo: "executar", entrada: p.id, fonte: "local" });
    setTimeout(() => {
      pendente = null; renderPendente();
      legenda("WhatsApp aberto com o texto pronto. Depois de enviar, marque Contato realizado na ficha do lead.");
    }, 150);
  });

  $("contatoForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const nome = $("contatoNome").value.trim().replace(/\s+/g, " "), tel = $("contatoTel").value.trim(), erro = $("contatoErro");
    const mostrar = (m) => { erro.textContent = m; erro.hidden = false; };
    const n = JarvisContatos.normalizarTel(tel);
    if (!n.tel) return mostrar(n.motivo === "fixo" ? "Telefone fixo não tem WhatsApp. Use o celular." : "Telefone inválido. Use DDD + número, ex.: 63 99999-0000.");
    const r = JarvisContatos.mesclar(lerContatos(), [{ nome, tel: JarvisContatos.formatarTel(n.tel) }]);
    if (!r.adicionados) return mostrar("Esse telefone já está nos contatos.");
    erro.hidden = true; gravarContatos(r.lista);
    $("contatoNome").value = ""; $("contatoTel").value = ""; renderContatos(); renderSugestoes();
  });
  $("buscaContato").addEventListener("input", renderContatos);
  $("arquivoContatos").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importarArquivo(f); });
  // Escolher no celular (Android/Chrome, quando o navegador deixa; dentro de um artefato costuma ser bloqueado)
  if ("contacts" in navigator && "ContactsManager" in window) {
    $("btnPicker").hidden = false;
    $("btnPicker").addEventListener("click", async () => {
      try {
        const sel = await navigator.contacts.select(["name", "tel"], { multiple: true });
        if (sel.length) aplicarImportacao(JarvisContatos.consolidar(sel.map((c) => ({ nome: (c.name || [])[0] || "", tels: c.tel || [] }))));
      } catch (_) { msgImporta("O navegador não liberou a lista de contatos aqui. Importe o arquivo exportado.", "erro"); }
    });
  }
  let apagarT = 0;
  $("btnApagarTodos").addEventListener("click", (e) => {     // confirmação em dois toques (sem janela de confirmação)
    const b = e.currentTarget, n = lerContatos().length;
    if (!n) return;
    if (b.dataset.armado) { clearTimeout(apagarT); delete b.dataset.armado; b.textContent = "Apagar todos"; gravarContatos([]); renderContatos(); renderSugestoes(); msgImporta("Contatos apagados deste navegador."); return; }
    b.dataset.armado = "1"; b.textContent = `Toque de novo para apagar ${n}`;
    apagarT = setTimeout(() => { delete b.dataset.armado; b.textContent = "Apagar todos"; }, 4000);
  });

  // painel de leads
  const selO = $("leadOrigem");
  for (const o of ["", ...L.ORIGENS]) { const op = document.createElement("option"); op.value = o; op.textContent = o || "Origem (opcional)"; selO.appendChild(op); }
  document.querySelectorAll("#leadsFiltros .fil").forEach((b) => b.addEventListener("click", () => { filtroLeads = b.dataset.f; renderLeads(); }));
  $("leadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const erro = $("leadErro"), novo = L.novo({ nome: $("leadNome").value, tel: $("leadTel").value, origem: $("leadOrigem").value, interesse: $("leadInteresse").value });
    if (novo.erro) { erro.textContent = novo.erro === "fixo" ? "Telefone fixo não tem WhatsApp. Use o celular." : "Telefone inválido. Use DDD + número."; erro.hidden = false; return; }
    if (L.porId(novo.id)) { erro.textContent = "Esse telefone já é um lead."; erro.hidden = false; return; }
    erro.hidden = true;
    if (await L.salvar(novo)) { ["leadNome", "leadTel", "leadInteresse"].forEach((i) => { $(i).value = ""; }); selO.value = ""; sfx("confirmar"); }
    else { erro.textContent = L.aviso || "Não consegui salvar."; erro.hidden = false; }
  });
  $("btnLeadsCsv").addEventListener("click", () => salvarArquivo(`leads-${hojeISO()}.csv`, L.csv(L.lista()), "text/csv"));
  L.aoMudar(() => { renderLeads(); atualizarModoLeads(); });
  L.aoMudar(renderCrm);
  F.aoMudar(() => {
    renderFin();
    if (modoId === "contador" || modoId === "gestao") JarvisData.get(modoId).then((d) => { dados = d; renderModo(); });
  });
  $("crmFechar").addEventListener("click", fecharAreas);
  $("rotFechar").addEventListener("click", fecharAreas); $("socFechar").addEventListener("click", fecharAreas);
  for (const f of SC.FORMATOS) { const o = document.createElement("option"); o.value = o.textContent = f; $("socFormato").append(o); }
  $("socData").value = hojeISO();
  $("socComForm").addEventListener("submit", (e) => { e.preventDefault(); const c = SC.novoComentario({ autor: $("socAutor").value, texto: $("socTexto").value }); if (c.erro) return; const d = SC.ler(); d.comentarios.push(c); SC.salvar(d); $("socTexto").value = ""; $("socAutor").value = ""; });
  $("socPostForm").addEventListener("submit", (e) => { e.preventDefault(); const p = SC.novoPost({ tema: $("socTema").value, data: $("socData").value, formato: $("socFormato").value }, hojeISO()); if (p.erro) return; const d = SC.ler(); d.posts.push(p); SC.salvar(d); $("socTema").value = ""; });
  $("socCsv").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return; const r = SC.lerMetricas(JarvisContatos._lerCsvLinhas(await f.text()));
    if (r.erro) { $("socStatus").textContent = r.erro; return; } const d = SC.ler(); d.metricas = r.posts; SC.salvar(d); $("socStatus").textContent = `${r.posts.length} publicações importadas.`; e.target.value = "";
  });
  $("socAnalisar").addEventListener("click", async () => {
    const m = SC.melhores(SC.ler().metricas, 5); if (!m.length) { $("socStatus").textContent = "Importe o CSV antes de analisar."; return; }
    setEstado("pensando"); const r = await JarvisBrain.perguntarClaude({ modo: MODOS.social, texto: "Analise estes posts do Instagram da clínica e diga o que repetir e o que mudar (3 a 5 itens curtos): " + m.map((x) => `${x.titulo} (alcance ${x.alcance}, curtidas ${x.curtidas}, comentários ${x.comentarios}, salvos ${x.salvos})`).join("; "), contexto: contextoClaude(), historico: [] });
    setEstado("idle"); if (!r || r.erro) { mostrarCard("Análise", ["O Claude não está disponível agora. Veja os melhores posts na lista abaixo."]); return; } mostrarCard(r.titulo || "Análise dos posts", r.itens.length ? r.itens : [r.fala]);
  });
  for (const [id, a] of [["rotAbaDia", "dia"], ["rotAbaSemana", "semana"], ["rotAbaMes", "mes"], ["rotAbaAno", "ano"]]) $(id).addEventListener("click", () => { rotAba = a; renderRotina(); });
  const passo = (n) => { if (rotAba === "dia") rotDia = L.somar(rotDia, n); else if (rotAba === "semana") rotDia = L.somar(rotDia, 7 * n); else if (rotAba === "mes") { rotMes = RT.somarMes(rotMes, n); rotDia = rotMes + "-01"; } else { rotAno += n; rotDia = rotAno + "-01-01"; } rotMes = rotDia.slice(0, 7); renderRotina(); };
  $("rotAnt").addEventListener("click", () => passo(-1)); $("rotSeg").addEventListener("click", () => passo(1));
  $("rotHoje").addEventListener("click", () => { rotDia = hojeISO(); rotMes = rotDia.slice(0, 7); rotAno = +rotDia.slice(0, 4); renderRotina(); });
  $("rotCompData").value = hojeISO();
  $("rotTarefaForm").addEventListener("submit", (e) => { e.preventDefault(); const t = $("rotTarefaTexto").value.trim(); if (!t) return; salvarPessoal((x) => x.tarefas.push({ id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), texto: t, dia: rotDia, feita: false })); $("rotTarefaTexto").value = ""; renderRotina(); });
  $("rotCompForm").addEventListener("submit", (e) => { e.preventDefault(); const c = RT.novoCompromisso({ titulo: $("rotCompTitulo").value, data: $("rotCompData").value || rotDia, hora: $("rotCompHora").value }); if (c.erro) return; const d = RT.ler(); d.compromissos.push(c); RT.salvar(d); $("rotCompTitulo").value = ""; $("rotCompHora").value = ""; });
  $("rotAguaMais").addEventListener("click", () => RT.salvar(RT.comAgua(RT.ler(), 1, rotDia))); $("rotAguaMenos").addEventListener("click", () => RT.salvar(RT.comAgua(RT.ler(), -1, rotDia)));
  $("rotCopiar").addEventListener("click", () => { const f = RT.feedbackSemana(RT.montarSemana(new Date(), rotDia)); copiar("Feedback da semana\n" + f.itens.map((x) => "- " + x.texto).join("\n")); });
  $("finFechar").addEventListener("click", fecharAreas);
  $("finAnterior").addEventListener("click", () => { mesFin = F.mesAnterior(mesFin); renderFin(); });
  $("finSeguinte").addEventListener("click", () => { mesFin = F.mesSeguinte(mesFin); renderFin(); });
  $("finData").value = hojeISO();
  $("finForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const l = F.novo({ tipo: $("finTipo").value, descricao: $("finDescricao").value, valor: Number($("finValor").value), categoria: $("finCategoria").value || undefined,
      status: $("finSituacao").value, data: $("finData").value || hojeISO(), vencimento: $("finVencimento").value });
    if (l.erro) { $("finErro").textContent = "Informe um valor maior que zero."; return; }
    if (!(await F.salvar(l))) { $("finErro").textContent = F.aviso || "Não consegui salvar."; return; }
    $("finErro").textContent = ""; $("finDescricao").value = ""; $("finValor").value = ""; $("finVencimento").value = "";
    mesFin = F.mesDe(l.data); renderFin();
  });
  for (const c of F.CATEGORIAS.despesa.concat(F.CATEGORIAS.receita.filter((x) => !F.CATEGORIAS.despesa.includes(x)))) { const o = document.createElement("option"); o.value = c; o.textContent = c; $("finCategoria").append(o); }
  $("fixaForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = F.novaFixa({ descricao: $("fixaDescricao").value, valor: Number($("fixaValor").value), dia: $("fixaDia").value });
    if (f.erro) { $("finErro").textContent = "Informe descrição e valor maior que zero."; return; }
    if (!(await F.salvar(f))) { $("finErro").textContent = F.aviso || "Não consegui salvar."; return; }
    $("finErro").textContent = ""; $("fixaDescricao").value = ""; $("fixaValor").value = ""; $("fixaDia").value = ""; renderFin();
  });
  $("finLancarFixas").addEventListener("click", async () => {
    const r = await lancarFixasDoMes(mesFin);
    $("finStatus").textContent = !r.total ? "Cadastre uma despesa fixa primeiro." : r.novos ? `${r.novos} despesa(s) fixa(s) lançada(s) em ${F.nomeMes(mesFin)}.` : "As fixas deste mês já estavam lançadas."; renderFin();
  });
  $("finCsv").addEventListener("click", () => salvarArquivo(`financeiro-${mesFin}.csv`, F.csvMes(F.lista(), mesFin), "text/csv"));
  $("finRelatorio").addEventListener("click", () => copiar(F.relatorioTexto(F.lista(), mesFin)));
  $("finFecharMes").addEventListener("click", async () => {
    if (await F.fecharMes(mesFin)) { $("finStatus").textContent = `Fechamento de ${F.nomeMes(mesFin)} registrado.`; renderFin(); }
    else $("finErro").textContent = F.aviso || "Não consegui fechar.";
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
    if (!infoVoz.entrada) {      // sem ditado neste aparelho: explica em vez de ficar mudo
      legenda(infoVoz.artefato
        ? "Neste aparelho o ditado do link não funciona. Toque no campo de texto e use o microfone do teclado."
        : "Este navegador não tem reconhecimento de voz. Digite o pedido.");
      sfx("erro"); $("entrada").focus(); return;
    }
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
    if (e.code === "Space" && !e.repeat && !emCampo()) { e.preventDefault(); pttInicio(); return; }
    if (e.key === "/" && !emCampo()) { e.preventDefault(); $("entrada").focus(); return; }
    if (e.key === "Escape" && !/^(input|textarea|select)$/i.test(document.activeElement.tagName)) {
      if (estado === "falando") { geracao++; JarvisVoice.parar(); setEstado("idle"); }
      else if (pendente) processar("cancela", "tecla");
    }
  });
  document.addEventListener("keyup", (e) => { if (e.code === "Space" && JarvisVoice.segurando) pttFim(); });

  $("btnMudo").addEventListener("click", () => {
    JarvisVoice.mudo = !JarvisVoice.mudo; JarvisSfx.mudo = JarvisVoice.mudo;
    $("btnMudo").innerHTML = JarvisVoice.mudo ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3m13 0 6 6m0-6-6 6"/></svg>' : '<span data-icon="volume"></span>';
    if (window.JarvisUI) JarvisUI.iconizar($("btnMudo"));
    $("btnMudo").setAttribute("aria-pressed", String(JarvisVoice.mudo));
  });
  $("btnTec").addEventListener("click", () => { $("tecnico").hidden = !$("tecnico").hidden; renderLog(); });
  $("btnLimpar").addEventListener("click", () => { gravar(LOG_KEY, []); renderLog(); });
  $("btnExportar").addEventListener("click", exportarLog);
  $("entrada").addEventListener("input", () => avatar.impulso(.3));        // a luz reage a cada tecla

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
    btnPtt.setAttribute("aria-disabled", String(semEntrada)); btnPtt.classList.toggle("indisp", semEntrada);
    btnPtt.title = semEntrada ? "Falar não funciona neste aparelho: use o microfone do teclado no campo de texto." : "Segure para falar (ou segure a tecla Espaço)";
    if (semEntrada) $("entrada").placeholder = i.artefato ? "Escreva ou use o ditado do teclado…" : "O que vamos cuidar agora?";
    $("btnMic").hidden = !i.continuo; $("btnMic").disabled = !i.continuo;
    $("medidorBox").hidden = i.entrada !== "navegador";
    $("btnMudo").disabled = !i.saida;
    $("vozInfo").textContent =
      (i.saida === "claude" ? "Voz: Claude." : i.saida === "navegador" ? "Voz: do seu sistema." : "Sem voz neste navegador/app: o texto aparece na tela.") + " " +
      (i.entrada === "ditado" ? "Entrada: ditado do claude.ai." : i.entrada === "navegador" ? "Entrada: reconhecimento do navegador."
        : i.artefato ? "Falar com o Jarvis não funciona neste aparelho: toque no campo de texto e use o microfone do teclado." : "Entrada por voz indisponível: digite.");
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
    onPalavra() { avatar.impulso(.55); },
    onNivel(n) { avatar.setNivel(n); $("medidor").style.width = Math.round(n * 100) + "%"; },
    onEstado(on) {
      if (on && estado !== "falando") { setEstado("ouvindo"); sfx("ouvir"); }
      else if (!on && estado === "ouvindo") setEstado("idle");
    },
    onErro(msg) {
      legenda(msg); sfx("erro");
      $("btnMic").classList.remove("on"); $("btnMic").setAttribute("aria-pressed", "false"); btnPtt.classList.remove("ptt-on");
    },
    onVozes() { popularVozes(); },
  });
  let pulsoT = 0;
  function pulso(n) { avatar.setNivel(n); clearTimeout(pulsoT); pulsoT = setTimeout(() => avatar.setNivel(0), 220); }

  // Tela de abertura curta: mostra o que foi carregado e some sozinha (ou ao toque/tecla).
  function boot() {
    const el = $("boot"); if (reduzido || sessionStorageVisto()) return;
    el.hidden = false;
    const linhas = [["Núcleo", "ok"], ["Voz", infoVoz.entrada === "ditado" ? "ditado + voz Claude" : infoVoz.entrada === "navegador" ? "navegador" : "só texto"],
                    ["Agentes", JARVIS_ORDEM.length + " carregados"], ["Contatos", String(lerContatos().length)], ["Dados", "seus leads, contas e rotina"]];
    const ul = $("bootLinhas"); ul.textContent = "";
    linhas.forEach(([k, v], i) => setTimeout(() => {
      const li = document.createElement("li"), a = document.createElement("span"), b = document.createElement("span");
      a.textContent = k; b.textContent = v; b.className = "ok"; li.append(a, b); ul.appendChild(li);
    }, 160 + i * 170));
    const sair = () => { el.classList.add("sai"); setTimeout(() => { el.hidden = true; }, 650); document.removeEventListener("keydown", sair); el.removeEventListener("pointerdown", sair); };
    el.addEventListener("pointerdown", sair); document.addEventListener("keydown", sair, { once: true });
    setTimeout(sair, 1300 + linhas.length * 90);
  }
  function sessionStorageVisto() { try { if (sessionStorage.getItem("jarvis_boot")) return true; sessionStorage.setItem("jarvis_boot", "1"); } catch (_) {} return false; }

  setInterval(() => { $("relogio").textContent = new Date().toLocaleTimeString("pt-BR"); }, 1000);

  // ---------- início ----------
  renderChips(); renderModo(); setEstado("idle"); renderLog(); renderContatos(); renderLeads(); aplicarVoz(infoVoz);
  L.iniciar().then(() => { renderLeads(); atualizarModoLeads(); renderCrm(); });
  F.iniciar().then(() => { renderFin(); if (modoId === "gestao" || modoId === "contador") JarvisData.get(modoId).then((d) => { dados = d; renderModo(); }); });
  JarvisVoice.pronto.then(aplicarVoz);
  if (window.matchMedia && matchMedia("(max-width:900px)").matches) $("entrada").placeholder = "O que vamos cuidar?";
  boot();
  legenda("Estou por aqui. O que merece sua atenção agora?");
  setTimeout(() => vigiarAvisos(true), reduzido ? 600 : 2600); setInterval(() => vigiarAvisos(false), 10 * 60 * 1000);
})();
