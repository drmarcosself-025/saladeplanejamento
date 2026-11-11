// Leads: funil simples com data de retorno obrigatória.
// REGRA CENTRAL: todo lead ativo tem uma data de próximo contato. É isso que
// impede que ele se perca: o que passou da data aparece como "atrasado".
//
// Armazenamento:
//   - dentro do claude.ai: capacidade `db` (sincroniza iPhone e computador;
//     um documento por lead, id = telefone, então não há duplicata);
//   - fora (ou se o db não estiver disponível): localStorage deste navegador.
// A parte pura (datas, funil, mensagens, CSV) é testável em Node.
(function () {
  const ETAPAS = [
    { id: "novo", nome: "Novo" }, { id: "conversando", nome: "Conversando" },
    { id: "orcamento", nome: "Orçamento enviado" }, { id: "agendou", nome: "Agendou" },
    { id: "fechou", nome: "Fechou" }, { id: "perdido", nome: "Perdido" },
  ];
  const ATIVAS = new Set(["novo", "conversando", "orcamento", "agendou"]);
  const ORIGENS = ["Instagram", "Google", "Facebook", "Indicação", "WhatsApp", "Outro"];
  const nomeEtapa = (id) => (ETAPAS.find((e) => e.id === id) || { nome: id }).nome;
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
  // "amanhã", "daqui a 3 dias", "sexta", "15/12", "dia 20", "semana que vem" → AAAA-MM-DD (ou null)
  function dataDe(texto, agora) {
    agora = agora || new Date();
    const t = norm(texto), hoje = iso(agora);
    if (/\bdepois de amanha\b/.test(t)) return somar(hoje, 2);
    if (/\bamanha\b/.test(t)) return somar(hoje, 1);
    if (/\bhoje\b/.test(t)) return hoje;
    let m = t.match(/\b(?:daqui a|em)\s+(\d{1,3})\s+dias?\b/) || t.match(/^(\d{1,3})\s+dias?$/);
    if (m) return somar(hoje, +m[1]);
    if (/\b(semana que vem|proxima semana|uma semana)\b/.test(t)) return somar(hoje, 7);
    m = t.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)\b/);
    if (m) { let d = (DIAS[m[1]] - agora.getDay() + 7) % 7; if (d === 0) d = 7; return somar(hoje, d); }
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (m) {
      const dia = +m[1], mes = +m[2]; if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
      let a = agora.getFullYear(), s = `${a}-${p2(mes)}-${p2(dia)}`;
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

  // Cria o objeto de um lead novo, ou { erro } se o telefone não serve.
  function novo(d, agora) {
    agora = agora || new Date();
    const C = window.JarvisContatos;
    const n = C.normalizarTel(d.tel);
    if (!n.tel) return { erro: n.motivo === "fixo" ? "fixo" : "telefone" };
    const nome = limpa(d.nome).slice(0, 60) || C.formatarTel(n.tel);
    return {
      id: n.tel, nome, tel: C.formatarTel(n.tel), origem: cap(limpa(d.origem)).slice(0, 40), interesse: limpa(d.interesse).slice(0, 80),
      etapa: "novo", proximo: iso(agora), criado: agora.toISOString(), atualizado: agora.toISOString(), ultimoContato: "", notas: "",
    };
  }
  // Garante a regra central: lead ativo sempre tem data; fechado/perdido não cobra.
  function garantirRegra(l, agora) {
    const hoje = iso(agora || new Date()), r = { ...l };
    if (ativo(r) && !r.proximo) r.proximo = hoje;
    if (!ativo(r)) r.proximo = "";
    return r;
  }
  function comEtapa(l, etapa, agora) {
    agora = agora || new Date();
    return garantirRegra({ ...l, etapa, atualizado: agora.toISOString() }, agora);
  }
  function comProximo(l, proximo, agora) {
    agora = agora || new Date();
    return garantirRegra({ ...l, proximo, atualizado: agora.toISOString() }, agora);
  }
  // Depois de contatar: registra o contato e já marca o próximo (padrão: +2 dias).
  function aposContato(l, agora, dias) {
    agora = agora || new Date();
    const hoje = iso(agora);
    return garantirRegra({ ...l, ultimoContato: hoje, etapa: l.etapa === "novo" ? "conversando" : l.etapa, proximo: somar(hoje, dias || 2), atualizado: agora.toISOString() }, agora);
  }
  function ordenar(ls) {
    return ls.slice().sort((a, b) => (a.proximo || "9999").localeCompare(b.proximo || "9999") || String(a.criado).localeCompare(String(b.criado)));
  }
  // filtro: "hoje" (vence hoje), "atrasados", "devidos" (hoje + atrasados), "todos" (ativos)
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
    const a = ls.filter(ativo), funil = {};
    for (const e of ETAPAS) funil[e.id] = ls.filter((l) => l.etapa === e.id).length;
    return {
      total: ls.length, ativos: a.length, funil,
      hoje: a.filter((l) => l.proximo === hoje).length,
      atrasados: a.filter((l) => l.proximo && l.proximo < hoje).length,
      semData: a.filter((l) => !l.proximo).length,
      fechados: funil.fechou, perdidos: funil.perdido,
    };
  }
  // Sugestão de mensagem de retorno por etapa (curta, sem prometer preço nem resultado).
  function mensagemRetorno(l) {
    const nome = primeiroNome(l.nome), tema = l.interesse ? l.interesse.toLowerCase() : "";
    const sobre = tema ? ` sobre ${tema}` : "";
    switch (l.etapa) {
      case "orcamento": return `Oi, ${nome}! Conseguiu avaliar o orçamento${sobre}? Se tiver qualquer dúvida, posso te explicar tudo por aqui. 😊`;
      case "agendou": return `Oi, ${nome}! Passando para confirmar a sua consulta. Está tudo certo para você?`;
      case "conversando": return `Oi, ${nome}! Passando para saber se ficou alguma dúvida${sobre}. Posso te ajudar a escolher um horário? 😊`;
      default: return `Olá, ${nome}! Aqui é da clínica. Vi que você tem interesse${tema ? " em " + tema : ""}. Posso te passar mais informações ou já agendar uma avaliação? 😊`;
    }
  }
  function csv(ls) {
    const cab = ["Nome", "Telefone", "Origem", "Interesse", "Etapa", "Próximo contato", "Último contato", "Criado em"];
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const linhas = ordenar(ls).map((l) => [l.nome, l.tel, l.origem, l.interesse, nomeEtapa(l.etapa), l.proximo, l.ultimoContato, String(l.criado || "").slice(0, 10)].map(q).join(";"));
    return "﻿" + [cab.map(q).join(";"), ...linhas].join("\r\n") + "\r\n";
  }

  // ---------- armazenamento ----------
  const LS = "jarvis_leads_v1";
  const S = { modo: "local", db: null, leads: [], ouvintes: [], aviso: "", confirmado: false, timer: 0, filas: {} };
  const avisar = () => S.ouvintes.forEach((f) => { try { f(); } catch (_) {} });
  function msgErro(e) {
    const c = e && e.code;
    if (c === "quota_exceeded") return "O armazenamento do claude.ai está cheio. Apague leads antigos (fechados ou perdidos).";
    if (c === "resource_exhausted") return "Muitas alterações seguidas. Espere um instante e tente de novo.";
    if (c === "invalid_argument") return "Só o dono do artefato pode gravar leads.";
    if (c === "revoked" || c === "not_granted") return "Sem acesso ao armazenamento do claude.ai nesta sessão.";
    return "Não consegui salvar agora. Tente de novo.";
  }
  function lerLocal() { try { return JSON.parse(localStorage.getItem(LS) || "[]"); } catch (_) { return []; } }
  function gravarLocal() { try { localStorage.setItem(LS, JSON.stringify(S.leads)); return true; } catch (_) { S.aviso = "Não coube no armazenamento do navegador."; return false; } }
  const enfileirar = (id, fn) => {
    const p = (S.filas[id] || Promise.resolve()).then(fn, fn);
    S.filas[id] = p.catch(() => {}); return p;
  };

  async function iniciar() {
    let db = null;
    try { if (window.claude && typeof window.claude.use === "function") db = await window.claude.use("db"); } catch (_) { db = null; }
    if (!db) { S.modo = "local"; S.leads = lerLocal(); avisar(); return S.modo; }
    S.modo = "claude"; S.db = db;
    S.timer = setTimeout(() => { if (!S.confirmado) { S.aviso = "Ainda não consegui alcançar o armazenamento do claude.ai. Os leads podem estar desatualizados."; avisar(); } }, 10000);
    db.collection("leads").onSnapshot((snap) => {
      S.leads = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (!snap.metadata.fromCache) { S.confirmado = true; clearTimeout(S.timer); S.aviso = ""; }
      avisar();
    }, (e) => { S.aviso = msgErro(e); avisar(); });
    return S.modo;
  }
  // Grava (cria ou substitui) um lead. Devolve true/false.
  async function salvar(lead) {
    const { id, ...corpo } = lead;
    if (S.modo === "claude") {
      try { await enfileirar(id, () => S.db.doc("leads/" + id).set(corpo)); S.aviso = ""; return true; }
      catch (e) { S.aviso = msgErro(e); avisar(); return false; }
    }
    const i = S.leads.findIndex((l) => l.id === id);
    if (i >= 0) S.leads[i] = lead; else S.leads.push(lead);
    const ok = gravarLocal(); avisar(); return ok;
  }
  async function remover(id) {
    if (S.modo === "claude") {
      try { await enfileirar(id, () => S.db.doc("leads/" + id).delete()); return true; }
      catch (e) { S.aviso = msgErro(e); avisar(); return false; }
    }
    S.leads = S.leads.filter((l) => l.id !== id); gravarLocal(); avisar(); return true;
  }

  window.JarvisLeads = {
    ETAPAS, ORIGENS, nomeEtapa, ativo,
    // puras
    iso, somar, rotulo, dataDe, novo, garantirRegra, comEtapa, comProximo, aposContato, ordenar, filtrar, resumo, mensagemRetorno, csv,
    // armazenamento
    iniciar, salvar, remover,
    lista: () => S.leads.slice(),
    get modo() { return S.modo; }, get aviso() { return S.aviso; },
    aoMudar(f) { S.ouvintes.push(f); },
    buscar(consulta) { return window.JarvisBrain.acharContato(consulta, S.leads); },
    porId: (id) => S.leads.find((l) => l.id === id) || null,
  };
})();
