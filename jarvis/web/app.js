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
  function abrirCrm(id) { $("crmTela").hidden = false; $("finTela").hidden = true; $("crmTela").querySelector(".workspace-head").after($("respostaCard")); if (id) leadAberto = id; renderCrm(); }
  function fecharAreas() { $("crmTela").hidden = true; $("finTela").hidden = true; $("legendaSr").after($("respostaCard")); }
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
  function abrirFin() { $("finTela").hidden = false; $("crmTela").hidden = true; $("finTela").querySelector(".workspace-head").after($("respostaCard")); renderFin(); }
  function renderFin() {
    const ls = F.lista(), r = F.resumoMes(ls, mesFin), itens = F.doMes(ls, mesFin);
    $("finMes").textContent = F.nomeMes(mesFin);
    $("finStatus").textContent = F.aviso || (F.modo === "claude" ? "Dados salvos no seu artefato Claude." : "Dados salvos neste navegador.");
    metricas("finMetricas", [["Receitas recebidas", valor(r.receitas)], ["Despesas pagas", valor(r.despesas)], ["Saldo pago", valor(r.saldo)], ["A pagar", valor(r.aPagar)], ["A receber", valor(r.aReceber)]]);
    const cats = $("finCategorias"); cats.textContent = "";
    for (const c of r.categorias) { const e = mk("div", "", `${c.categoria} · ${valor(c.total)}`), b = mk("div", "categoria-barra"), i = mk("i"); i.style.width = Math.round(c.pct * 100) + "%"; b.append(i); e.append(b); cats.append(e); }
    const ul = $("finLista"); ul.textContent = "";
    for (const l of itens.sort((a,b) => b.data.localeCompare(a.data))) {
      const li = mk("li"), tx = mk("div"); tx.append(mk("strong", "", `${l.tipo === "receita" ? "+" : "−"}${valor(l.valor)} · ${l.descricao || l.categoria}`), mk("small", "", `${l.data} · ${l.categoria} · ${l.status === "pendente" ? "Pendente " + (l.vencimento || "") : "Pago/recebido"}`));
      const a = mk("div", "row");
      if (l.status === "pendente") { const b = mk("button", "btn", "Marcar pago"); b.type = "button"; b.addEventListener("click", () => F.salvar(F.comPago(l))); a.append(b); }
      const del = mk("button", "btn", "Apagar"); del.type = "button"; del.addEventListener("click", () => {
        if (del.dataset.armado) F.remover(l.id); else { del.dataset.armado = "1"; del.textContent = "Confirmar exclusão"; setTimeout(() => { if (del.isConnected) { del.textContent = "Apagar"; delete del.dataset.armado; } }, 4000); }
      }); a.append(del); li.append(tx, a); ul.append(li);
    }
    if (!itens.length) ul.append(mk("li", "muted", "Nenhum lançamento neste mês."));
    $("finFecharMes").textContent = F.fechamentoDe(mesFin) ? "Atualizar fechamento" : "Fechar o mês";
  }
  function contextoClaude() {
    const modo = MODOS[modoId], ls = L.lista(), r = L.resumo(ls), mes = F.mesDe(hojeISO()), f = F.resumoMes(F.lista(), mes);
    const devidos = L.filtrar(ls, "devidos").slice(0, 5).map((l) => `${l.nome}: ${l.interesse || "sem interesse informado"}, retorno ${l.proximo}`).join("; ");
    return [window.JarvisPessoal ? JarvisPessoal.contexto() : "", `Modo: ${modo.nome}; ${modo.resumo}`, `Leads: ${r.ativos} ativos, ${r.hoje} hoje, ${r.atrasados} atrasados. Devidos: ${devidos || "nenhum"}.`,
      `Financeiro ${mes}: recebido ${valor(f.receitas)}, pago ${valor(f.despesas)}, a pagar ${valor(f.aPagar)}, a receber ${valor(f.aReceber)}.`,
      modoId === "gestao" ? "Agenda e e-mails na tela são apenas demonstração; não use esses nomes como dados reais." : ""].filter(Boolean).join("\n");
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
    const total = Math.min(14000, 1100 + texto.length * 52), passo = Math.max(14, Math.min(45, total / texto.length));
    let i = 0; el.classList.add("digitando");
    digitacao = setInterval(() => {
      i += Math.max(1, Math.round(texto.length / (total / passo) ));
      el.textContent = texto.slice(0, i);
      if (i >= texto.length) { clearInterval(digitacao); el.classList.remove("digitando"); }
    }, passo);
  }
  async function dizer(texto, g) {
    legenda(texto, true); registrarConversa("jarvis", texto); setEstado("falando");
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
    if (window.JarvisUI) JarvisUI.navegar("conversa");
    modoId = id; pendente = null; aguardando = null; renderPendente();
    dados = id === "normal" ? {} : await JarvisData.get(id);
    if (g !== geracao) return;
    if (id === "leads") { $("painelLeads").open = true; renderLeads(); }
    if (id === "contador") abrirFin(); else fecharAreas();
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
    if (window.JarvisUI) JarvisUI.navegar("conversa");
    limparCard();
    acordadoAte = Date.now() + 12000; sfx("enviar");
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
    if (modoId === "gestao" && /\b(paciente|agenda|confirmac)/.test(it.texto)) {
      const pend = (dados.pacientes || []).filter((p) => !p.confirmado);
      mostrarCard("Agenda de demonstração", pend.map((p) => `${p.hora} · ${p.nome} · ${p.proc}`));
      return dizer(`A agenda é fictícia nesta versão. Mostrei ${pend.length} pacientes de demonstração sem confirmação.`, g);
    }
    if (modoId === "gestao" && /\b(e mail|email)/.test(it.texto)) {
      mostrarCard("E-mails de demonstração", (dados.emails || []).map((e) => `${e.de} · ${e.assunto}`));
      return dizer("Os e-mails são fictícios nesta versão. Mostrei a demonstração na tela.", g);
    }
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
  $("finFechar").addEventListener("click", fecharAreas);
  $("finAnterior").addEventListener("click", () => { mesFin = F.mesAnterior(mesFin); renderFin(); });
  $("finSeguinte").addEventListener("click", () => { mesFin = F.mesSeguinte(mesFin); renderFin(); });
  $("finData").value = hojeISO();
  $("finForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const l = F.novo({ tipo: $("finTipo").value, descricao: $("finDescricao").value, valor: Number($("finValor").value),
      status: $("finSituacao").value, data: $("finData").value || hojeISO(), vencimento: $("finVencimento").value });
    if (l.erro) { $("finErro").textContent = "Informe um valor maior que zero."; return; }
    if (!(await F.salvar(l))) { $("finErro").textContent = F.aviso || "Não consegui salvar."; return; }
    $("finErro").textContent = ""; $("finDescricao").value = ""; $("finValor").value = ""; $("finVencimento").value = "";
    mesFin = F.mesDe(l.data); renderFin();
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
                    ["Agentes", JARVIS_ORDEM.length + " carregados"], ["Contatos", String(lerContatos().length)], ["Dados", "leads/finanças seus; outras áreas demo"]];
    const ul = $("bootLinhas"); ul.textContent = "";
    linhas.forEach(([k, v], i) => setTimeout(() => {
      const li = document.createElement("li"), a = document.createElement("span"), b = document.createElement("span");
      a.textContent = k; b.textContent = v; b.className = "ok"; li.append(a, b); ul.appendChild(li);
    }, 160 + i * 170));
    const sair = () => { el.classList.add("sai"); setTimeout(() => { el.hidden = true; }, 650); document.removeEventListener("keydown", sair); el.removeEventListener("pointerdown", sair); };
    el.addEventListener("pointerdown", sair); document.addEventListener("keydown", sair, { once: true });
    setTimeout(sair, 1700 + linhas.length * 120);
  }
  function sessionStorageVisto() { try { if (sessionStorage.getItem("jarvis_boot")) return true; sessionStorage.setItem("jarvis_boot", "1"); } catch (_) {} return false; }

  setInterval(() => { $("relogio").textContent = new Date().toLocaleTimeString("pt-BR"); }, 1000);

  // ---------- início ----------
  renderChips(); renderModo(); setEstado("idle"); renderLog(); renderContatos(); renderLeads(); aplicarVoz(infoVoz);
  L.iniciar().then(() => { renderLeads(); atualizarModoLeads(); renderCrm(); });
  F.iniciar().then(() => { renderFin(); if (modoId === "gestao" || modoId === "contador") JarvisData.get(modoId).then((d) => { dados = d; renderModo(); }); });
  JarvisVoice.pronto.then(aplicarVoz);
  if (window.matchMedia && matchMedia("(max-width:900px)").matches) $("entrada").placeholder = "O que vamos cuidar agora?";
  boot();
  legenda("Estou por aqui. O que merece sua atenção agora?");
})();
