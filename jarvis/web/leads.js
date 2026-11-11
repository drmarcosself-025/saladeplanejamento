// Leads: funil com data de retorno obrigatória, histórico e valor.
// REGRA CENTRAL: todo lead ativo tem uma data de próximo contato. O que passou
// da data aparece como atrasado. É isso que impede que ele se perca.
// A parte pura (datas, funil, mensagens, CSV) é testável em Node; o
// armazenamento vem de store.js.
(function () {
  const ETAPAS = [
    { id: "novo", nome: "Novo contato" }, { id: "interessado", nome: "Interessado" },
    { id: "proposta", nome: "Proposta enviada" }, { id: "aguardando", nome: "Aguardando retorno" },
    { id: "agendou", nome: "Agendou" }, { id: "fechou", nome: "Fechou" }, { id: "sem_interesse", nome: "Sem interesse" },
  ];
  const ATIVAS = new Set(["novo", "interessado", "proposta", "aguardando", "agendou"]);
  const ALIAS = { conversando: "interessado", orcamento: "proposta", perdido: "sem_interesse" };   // nomes antigos
  // Em quantos dias cobrar de novo quando o lead entra na etapa (se o retorno já venceu).
  const DIAS_PADRAO = { novo: 0, interessado: 2, proposta: 2, aguardando: 3, agendou: 1 };
  const ORIGENS = ["Instagram", "Google", "Facebook", "Indicação", "WhatsApp", "Outro"];
  const nomeEtapa = (id) => (ETAPAS.find((e) => e.id === (ALIAS[id] || id)) || { nome: id }).nome;
  const ativo = (l) => ATIVAS.has(l.etapa);
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 /]/g, " ").replace(/\s+/g, " ").trim();

  // ---------- datas (sempre em horário local, como "AAAA-MM-DD") ----------
  const p2 = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const deIso = (s) => { const [a, m, d] = s.split("-").map(Number); return new Date(a, m - 1, d); };
  const somar = (s, n) => { const d = deIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const dif = (a, b) => Math.round((deIso(a) - deIso(b)) / 86400000);
  function rotulo(proximo, hoje) {
    if (!proximo) return "Sem data";
    const d = dif(proximo, hoje);
    if (d === 0) return "Hoje";
    if (d === 1) return "Amanhã";
    if (d < 0) return `Atrasado ${-d} dia${-d > 1 ? "s" : ""}`;
    if (d < 7) return `Em ${d} dias`;
    return `${proximo.slice(8, 10)}/${proximo.slice(5, 7)}`;
  }
  const DIAS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
  // "amanhã", "ontem", "daqui a 3 dias", "sexta", "15/12", "dia 20", "semana que vem" → AAAA-MM-DD (ou null)
  function dataDe(texto, agora) {
    agora = agora || new Date();
    const t = norm(texto), hoje = iso(agora);
    if (/\bdepois de amanha\b/.test(t)) return somar(hoje, 2);
    if (/\bamanha\b/.test(t)) return somar(hoje, 1);
    if (/\bantes de ontem\b|\banteontem\b/.test(t)) return somar(hoje, -2);
    if (/\bontem\b/.test(t)) return somar(hoje, -1);
    if (/\bhoje\b/.test(t)) return hoje;
    let m = t.match(/\b(?:daqui a|em)\s+(\d{1,3})\s+dias?\b/) || t.match(/^(\d{1,3})\s+dias?$/);
    if (m) return somar(hoje, +m[1]);
    if (/\b(semana que vem|proxima semana|uma semana)\b/.test(t)) return somar(hoje, 7);
    m = t.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)\b/);
    if (m) { let d = (DIAS[m[1]] - agora.getDay() + 7) % 7; if (d === 0) d = 7; return somar(hoje, d); }
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (m) {
      const dia = +m[1], mes = +m[2]; if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
      const a = agora.getFullYear(); let s = `${a}-${p2(mes)}-${p2(dia)}`;
      if (s < hoje) s = `${a + 1}-${p2(mes)}-${p2(dia)}`;
      return iso(deIso(s)) === s ? s : null;
    }
    m = t.match(/\bdia\s+(\d{1,2})\b/);
    if (m) {
      const dia = +m[1]; if (dia < 1 || dia > 31) return null;
      let d = new Date(agora.getFullYear(), agora.getMonth(), dia);
      if (iso(d) < hoje) d = new Date(agora.getFullYear(), agora.getMonth() + 1, dia);
      return d.getDate() === dia ? iso(d) : null;
    }
    return null;
  }

  // ---------- leads ----------
  const limpa = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const primeiroNome = (n) => limpa(n).split(" ")[0];

  // Acrescenta uma linha ao histórico (as 40 mais recentes ficam).
  function comHist(l, texto, agora) {
    const h = (l.historico || []).concat([{ ts: (agora || new Date()).toISOString(), texto }]);
    return { ...l, historico: h.slice(-40) };
  }
  // Lê o que veio do armazenamento: nomes antigos de etapa, campos novos.
  function migrar(l) {
    const etapa = ALIAS[l.etapa] || l.etapa || "novo";
    return { ...l, etapa, historico: Array.isArray(l.historico) ? l.historico : [], valor: typeof l.valor === "number" ? l.valor : null, notas: l.notas || "" };
  }
  function novo(d, agora) {
    agora = agora || new Date();
    const C = window.JarvisContatos, n = C.normalizarTel(d.tel);
    if (!n.tel) return { erro: n.motivo === "fixo" ? "fixo" : "telefone" };
    const nome = limpa(d.nome).slice(0, 60) || C.formatarTel(n.tel);
    const l = {
      id: n.tel, nome, tel: C.formatarTel(n.tel), origem: cap(limpa(d.origem)).slice(0, 40), interesse: limpa(d.interesse).slice(0, 80),
      etapa: "novo", proximo: iso(agora), criado: agora.toISOString(), atualizado: agora.toISOString(), ultimoContato: "", notas: "",
      valor: typeof d.valor === "number" && d.valor > 0 ? d.valor : null, historico: [],
    };
    return comHist(l, "Entrou como lead" + (l.origem ? ` (${l.origem})` : ""), agora);
  }
  // Garante a regra central: lead ativo sempre tem data; encerrado não cobra.
  function garantirRegra(l, agora) {
    const hoje = iso(agora || new Date()), r = { ...l };
    if (ativo(r) && !r.proximo) r.proximo = hoje;
    if (!ativo(r)) r.proximo = "";
    return r;
  }
  function comEtapa(l, etapa, agora) {
    agora = agora || new Date(); etapa = ALIAS[etapa] || etapa;
    if (l.etapa === etapa) return l;
    const hoje = iso(agora);
    let r = { ...l, etapa, atualizado: agora.toISOString() };
    if (ativo(r)) { if (!r.proximo || r.proximo <= hoje) r.proximo = somar(hoje, DIAS_PADRAO[etapa] || 0); } else r.proximo = "";
    return comHist(r, `Etapa: ${nomeEtapa(l.etapa)} → ${nomeEtapa(etapa)}`, agora);
  }
  function comProximo(l, proximo, agora) {
    agora = agora || new Date();
    const r = garantirRegra({ ...l, proximo, atualizado: agora.toISOString() }, agora);
    return comHist(r, `Retorno marcado para ${proximo.slice(8, 10)}/${proximo.slice(5, 7)}`, agora);
  }
  function comNota(l, texto, agora) {
    agora = agora || new Date();
    return comHist({ ...l, atualizado: agora.toISOString() }, "Nota: " + limpa(texto).slice(0, 300), agora);
  }
  function comValor(l, valor, agora) {
    agora = agora || new Date();
    const v = typeof valor === "number" && valor > 0 ? valor : null;
    if (v === l.valor) return l;
    return comHist({ ...l, valor: v, atualizado: agora.toISOString() }, v ? `Valor estimado: R$ ${v.toFixed(2).replace(".", ",")}` : "Valor removido", agora);
  }
  // Depois de contatar: registra o contato e já marca o próximo (padrão: +2 dias).
  function aposContato(l, agora, dias) {
    agora = agora || new Date();
    const hoje = iso(agora);
    const r = garantirRegra({ ...l, ultimoContato: hoje, proximo: somar(hoje, dias || 2), atualizado: agora.toISOString() }, agora);
    return comHist(r, "Retorno enviado por WhatsApp", agora);
  }
  function ordenar(ls) {
    return ls.slice().sort((a, b) => (a.proximo || "9999").localeCompare(b.proximo || "9999") || String(a.criado).localeCompare(String(b.criado)));
  }
  // filtro: "hoje", "atrasados", "devidos" (hoje + atrasados), "todos" (ativos)
  function filtrar(ls, filtro, agora) {
    const hoje = iso(agora || new Date());
    const a = ls.filter(ativo);
    const r = filtro === "atrasados" ? a.filter((l) => l.proximo && l.proximo < hoje)
      : filtro === "hoje" ? a.filter((l) => l.proximo === hoje)
      : filtro === "devidos" ? a.filter((l) => !l.proximo || l.proximo <= hoje)
      : a;
    return ordenar(r);
  }
  function resumo(ls, agora) {
    const hoje = iso(agora || new Date());
    const a = ls.filter(ativo), funil = {}, valorPorEtapa = {};
    for (const e of ETAPAS) {
      const ds = ls.filter((l) => l.etapa === e.id);
      funil[e.id] = ds.length; valorPorEtapa[e.id] = ds.reduce((s, l) => s + (l.valor || 0), 0);
    }
    const encerrados = funil.fechou + funil.sem_interesse;
    const porOrigem = {};
    for (const l of ls) { const o = l.origem || "Sem origem"; (porOrigem[o] = porOrigem[o] || { total: 0, fechou: 0 }).total++; if (l.etapa === "fechou") porOrigem[o].fechou++; }
    const fechados = ls.filter((l) => l.etapa === "fechou");
    return {
      total: ls.length, ativos: a.length, funil, valorPorEtapa,
      hoje: a.filter((l) => l.proximo === hoje).length,
      atrasados: a.filter((l) => l.proximo && l.proximo < hoje).length,
      semData: a.filter((l) => !l.proximo).length,
      fechados: funil.fechou, perdidos: funil.sem_interesse, semInteresse: funil.sem_interesse,
      emAberto: a.reduce((s, l) => s + (l.valor || 0), 0),                       // valor estimado de tudo que está ativo
      conversao: encerrados ? funil.fechou / encerrados : null,                    // fechou ÷ (fechou + sem interesse)
      ticket: fechados.length && fechados.some((l) => l.valor) ? fechados.reduce((s, l) => s + (l.valor || 0), 0) / fechados.filter((l) => l.valor).length : null,
      porOrigem,
    };
  }
  // Sugestão de mensagem de retorno por etapa (curta, sem prometer preço nem resultado).
  function mensagemRetorno(l) {
    const nome = primeiroNome(l.nome), tema = l.interesse ? l.interesse.toLowerCase() : "";
    const sobre = tema ? ` sobre ${tema}` : "";
    switch (l.etapa) {
      case "proposta": return `Oi, ${nome}! Conseguiu avaliar a proposta${sobre}? Se tiver qualquer dúvida, posso te explicar tudo por aqui. 😊`;
      case "aguardando": return `Oi, ${nome}! Passando para saber se você conseguiu pensar com calma${sobre}. Posso te ajudar em algo? 😊`;
      case "agendou": return `Oi, ${nome}! Passando para confirmar a sua consulta. Está tudo certo para você?`;
      case "interessado": return `Oi, ${nome}! Passando para saber se ficou alguma dúvida${sobre}. Posso te ajudar a escolher um horário? 😊`;
      default: return `Olá, ${nome}! Aqui é da clínica. Vi que você tem interesse${tema ? " em " + tema : ""}. Posso te passar mais informações ou já agendar uma avaliação? 😊`;
    }
  }
  function csv(ls) {
    const cab = ["Nome", "Telefone", "Origem", "Interesse", "Etapa", "Valor estimado", "Próximo contato", "Último contato", "Criado em"];
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const linhas = ordenar(ls).map((l) => [l.nome, l.tel, l.origem, l.interesse, nomeEtapa(l.etapa), l.valor == null ? "" : String(l.valor).replace(".", ","), l.proximo, l.ultimoContato, String(l.criado || "").slice(0, 10)].map(q).join(";"));
    return "﻿" + [cab.map(q).join(";"), ...linhas].join("\r\n") + "\r\n";
  }

  const store = window.JarvisStore.criar({ colecao: "leads", chaveLocal: "jarvis_leads_v1", normalizar: migrar });

  window.JarvisLeads = {
    ETAPAS, ORIGENS, nomeEtapa, ativo, migrar, DIAS_PADRAO,
    // puras
    iso, deIso, somar, dif, rotulo, dataDe, novo, garantirRegra, comEtapa, comProximo, comNota, comValor, aposContato, ordenar, filtrar, resumo, mensagemRetorno, csv,
    // armazenamento
    iniciar: store.iniciar, salvar: store.salvar, remover: store.remover, lista: store.lista, porId: store.porId, aoMudar: store.aoMudar,
    get modo() { return store.modo; }, get aviso() { return store.aviso; },
    buscar(consulta) { return window.JarvisBrain.acharContato(consulta, store.lista()); },
  };
})();
