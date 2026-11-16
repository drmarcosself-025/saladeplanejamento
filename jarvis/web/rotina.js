// Dia a Dia: compromissos, água, refeições, resumo do dia e feedback da semana.
// Tarefas (prioridades) continuam em pessoal.js; leads em leads.js; contas em fin.js. Tudo fica só neste navegador.
(function () {
  const KEY = "jarvis_rotina_v1", MAX = 400;
  const REFEICOES = [{ id: "cafe", nome: "Café da manhã" }, { id: "almoco", nome: "Almoço" }, { id: "lanche", nome: "Lanche" }, { id: "jantar", nome: "Jantar" }];
  const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"], DOW = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  const rx = /^\d{4}-\d{2}-\d{2}$/;
  const limpar = (v, max) => String(v == null ? "" : v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  const L = () => window.JarvisLeads;
  const deIso = (s) => { const [a, m, d] = s.split("-").map(Number); return new Date(a, m - 1, d); };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const somar = (s, n) => { const d = deIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const hhmm = (h) => h ? h.replace(/^0/, "").replace(":00", "h").replace(":", "h") : "";

  const vazio = () => ({ compromissos: [], agua: {}, refeicoes: {}, metaAgua: 8, metas: [] });
  function validar(raw) {
    const d = vazio(); if (!raw || typeof raw !== "object") return d;
    d.metaAgua = Math.max(1, Math.min(20, parseInt(raw.metaAgua, 10) || 8));
    d.compromissos = (Array.isArray(raw.compromissos) ? raw.compromissos : []).filter((c) => c && c.id && c.titulo && rx.test(c.data)).slice(-MAX)
      .map((c) => ({ id: limpar(c.id, 60), titulo: limpar(c.titulo, 120), data: c.data, hora: /^\d{2}:\d{2}$/.test(c.hora) ? c.hora : "", feito: c.feito === true }));
    d.metas = (Array.isArray(raw.metas) ? raw.metas : []).filter((m) => m && m.id && m.texto && (m.escopo === "mes" || m.escopo === "ano") && /^\d{4}(-\d{2})?$/.test(m.ref)).slice(-200)
      .map((m) => ({ id: limpar(m.id, 60), texto: limpar(m.texto, 160), escopo: m.escopo, ref: m.ref, feita: m.feita === true }));
    for (const [k, v] of Object.entries(raw.agua && typeof raw.agua === "object" ? raw.agua : {})) if (rx.test(k) && Number.isFinite(v)) d.agua[k] = Math.max(0, Math.min(40, Math.round(v)));
    for (const [k, v] of Object.entries(raw.refeicoes && typeof raw.refeicoes === "object" ? raw.refeicoes : {})) if (rx.test(k) && Array.isArray(v)) d.refeicoes[k] = [...new Set(v.filter((x) => REFEICOES.some((r) => r.id === x)))];
    return d;
  }
  let dados, ouvintes = [];
  try { dados = validar(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (_) { dados = vazio(); }
  const ler = () => JSON.parse(JSON.stringify(dados));
  function salvar(proximo) {
    const novo = validar(proximo);
    try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(novo)); dados = novo; ouvintes.forEach((f) => { try { f(); } catch (_) {} }); return true; } catch (_) { return false; }
  }
  const aoMudar = (f) => ouvintes.push(f);

  // ---------- hora e data ----------
  // "às 14h", "14:30", "9 horas", "meio dia", "9h30" → "HH:MM" (ou null)
  function lerHora(texto) {
    const t = String(texto).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/\bmeio[- ]?dia\b/.test(t)) return "12:00";
    if (/\bmeia[- ]?noite\b/.test(t)) return "00:00";
    let m = t.match(/\b(\d{1,2})\s*(?:h|:|horas?)\s*(\d{2})?\b/) || t.match(/\bas\s+(\d{1,2})(?:\s+horas?)?\b/);
    if (!m) return null;
    const h = +m[1], mi = m[2] ? +m[2] : 0; if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }

  // ---------- compromissos ----------
  function novoCompromisso(d, agora) {
    const titulo = limpar(d.titulo, 120); if (!titulo) return { erro: "titulo" };
    const data = rx.test(d.data) ? d.data : iso(agora || new Date());
    return { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), titulo, data, hora: /^\d{2}:\d{2}$/.test(d.hora) ? d.hora : "", feito: false };
  }
  const doDia = (lista, dia) => lista.filter((c) => c.data === dia).sort((a, b) => (a.hora || "99").localeCompare(b.hora || "99"));
  // ---------- água e refeições ----------
  const agua = (d, dia) => d.agua[dia] || 0;
  const comAgua = (d, n, dia) => { const x = JSON.parse(JSON.stringify(d)); x.agua[dia] = Math.max(0, Math.min(40, agua(d, dia) + n)); return x; };
  function comRefeicao(d, id, dia, ligar) {
    const x = JSON.parse(JSON.stringify(d)), l = new Set(x.refeicoes[dia] || []);
    if (ligar === undefined ? !l.has(id) : ligar) l.add(id); else l.delete(id); x.refeicoes[dia] = [...l]; return x;
  }
  // ---------- semana (segunda a domingo) ----------
  function semanaDe(dia) { const d = deIso(dia), seg = somar(dia, -((d.getDay() + 6) % 7)); return Array.from({ length: 7 }, (_, i) => somar(seg, i)); }
  const rotuloDia = (s) => DIAS[deIso(s).getDay()];
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

  // ---------- resumo do dia ----------
  // c = { hoje, nome, saudacao, compromissos[], tarefas[{texto,feita}], retornos, atrasados, contas[{descricao,valor,vencimento,atrasada}], agua, meta, refeicoes[] }
  function resumoDia(c) {
    const itens = [], pend = c.tarefas.filter((t) => !t.feita), compr = c.compromissos.filter((x) => !x.feito);
    for (const x of compr.slice(0, 6)) itens.push(`${x.hora ? hhmm(x.hora) + " · " : ""}${x.titulo}`);
    for (const t of pend.slice(0, 5)) itens.push(`Prioridade: ${t.texto}`);
    if (c.retornos + c.atrasados) itens.push(`${plural(c.retornos + c.atrasados, "retorno de lead", "retornos de leads")}${c.atrasados ? ` (${c.atrasados} atrasado${c.atrasados > 1 ? "s" : ""})` : ""}`);
    for (const x of c.contas.slice(0, 4)) itens.push(`Conta: ${x.descricao}, R$ ${x.valor.toFixed(2).replace(".", ",")}, ${x.atrasada ? "atrasada" : "vence " + x.vencimento.slice(8) + "/" + x.vencimento.slice(5, 7)}`);
    itens.push(`Água: ${c.agua} de ${c.meta} copos`);
    const falta = REFEICOES.filter((r) => !c.refeicoes.includes(r.id)).length; if (c.refeicoes.length) itens.push(`Refeições registradas: ${c.refeicoes.length} de 4`);
    const f = [];
    if (c.saudacao) f.push(`${c.saudacao}, ${c.nome}.`);
    f.push(compr.length ? `${c.prefixo || "Hoje você tem"} ${plural(compr.length, "compromisso", "compromissos")}${compr[0].hora ? `, o primeiro às ${hhmm(compr[0].hora)}: ${compr[0].titulo}` : ""}.` : (c.vazio || "Nenhum compromisso marcado para hoje."));
    const resto = []; if (pend.length) resto.push(plural(pend.length, "prioridade pendente", "prioridades pendentes"));
    if (c.retornos + c.atrasados) resto.push(plural(c.retornos + c.atrasados, "retorno de lead", "retornos de leads")); if (c.contas.length) resto.push(plural(c.contas.length, "conta para pagar", "contas para pagar"));
    f.push(resto.length ? `Também: ${resto.join(", ")}.` : "Sem pendências no momento.");
    if (c.agua < Math.ceil(c.meta / 2) && c.hora >= 12) f.push("Lembre de beber água.");
    void falta; return { itens, fala: f.join(" ") };
  }

  // ---------- feedback da semana ----------
  // c = { hoje, dias[{iso,compromissos[],tarefasTotal,tarefasFeitas,agua,refeicoes}], meta, retornos, atrasados, ativos, contas[{valor,atrasada}] }
  function feedbackSemana(c) {
    const it = [], passados = c.dias.filter((d) => d.iso <= c.hoje);
    const totC = c.dias.reduce((s, d) => s + d.compromissos.length, 0), restC = c.dias.filter((d) => d.iso >= c.hoje).reduce((s, d) => s + d.compromissos.filter((x) => !x.feito).length, 0);
    it.push({ nivel: "info", texto: totC ? `${plural(totC, "compromisso", "compromissos")} na semana; ${restC} ainda por vir.` : "Nenhum compromisso marcado nesta semana." });
    const tT = c.dias.reduce((s, d) => s + d.tarefasTotal, 0), tF = c.dias.reduce((s, d) => s + d.tarefasFeitas, 0);
    if (tT) it.push({ nivel: tF / tT >= .7 ? "bom" : "atencao", texto: `Prioridades: ${tF} de ${tT} concluídas (${Math.round(tF / tT * 100)}%).` });
    else it.push({ nivel: "info", texto: "Nenhuma prioridade registrada nesta semana." });
    const dev = c.retornos + c.atrasados;
    it.push(dev ? { nivel: c.atrasados ? "atencao" : "info", texto: `Leads: ${plural(dev, "retorno pendente", "retornos pendentes")}${c.atrasados ? `, ${c.atrasados} atrasado${c.atrasados > 1 ? "s" : ""}` : ""}.` } : { nivel: "bom", texto: c.ativos ? "Leads: nenhum retorno em atraso." : "Leads: nenhum lead ativo." });
    const atr = c.contas.filter((x) => x.atrasada).length, tot = c.contas.reduce((s, x) => s + x.valor, 0);
    it.push(atr ? { nivel: "atencao", texto: `Contas: ${plural(atr, "atrasada", "atrasadas")}; ${c.contas.length} no total (R$ ${tot.toFixed(2).replace(".", ",")}) até a próxima semana.` } : c.contas.length ? { nivel: "info", texto: `Contas: ${plural(c.contas.length, "vence", "vencem")} nos próximos 7 dias (R$ ${tot.toFixed(2).replace(".", ",")}).` } : { nivel: "bom", texto: "Contas: nada atrasado nem a vencer na semana." });
    const comAguaDias = passados.filter((d) => d.agua > 0);
    if (comAguaDias.length) { const m = comAguaDias.reduce((s, d) => s + d.agua, 0) / comAguaDias.length; it.push({ nivel: m >= c.meta * .8 ? "bom" : "atencao", texto: `Água: média de ${m.toFixed(1).replace(".", ",")} copos por dia (meta ${c.meta}).` }); }
    else it.push({ nivel: "info", texto: "Água: ainda sem registros. Diga “bebi um copo de água”." });
    const ok = passados.filter((d) => d.refeicoes >= 3).length;
    it.push(passados.some((d) => d.refeicoes) ? { nivel: ok >= Math.ceil(passados.length * .6) ? "bom" : "atencao", texto: `Alimentação: ${ok} de ${passados.length} dias com 3 refeições ou mais registradas.` } : { nivel: "info", texto: "Alimentação: sem registros. Diga “almocei” ou “jantei”." });
    const futuros = c.dias.filter((d) => d.iso >= c.hoje && ![0, 6].includes(deIso(d.iso).getDay())).map((d) => ({ d, n: d.compromissos.length + (d.tarefasTotal - d.tarefasFeitas) })).sort((a, b) => a.n - b.n);
    if (futuros.length > 1 && futuros[0].n < futuros[futuros.length - 1].n) it.push({ nivel: "info", texto: `Dias mais leves para planejar: ${futuros.filter((x) => x.n === futuros[0].n).slice(0, 3).map((x) => DIAS[deIso(x.d.iso).getDay()] + " " + x.d.iso.slice(8)).join(", ")}.` });
    const foco = c.atrasados ? "Comece pelos retornos atrasados de leads." : atr ? "Resolva as contas atrasadas primeiro." : tT - tF > 0 ? `Falta concluir ${plural(tT - tF, "prioridade", "prioridades")}.` : "A semana está em dia. Bom momento para planejar a próxima.";
    it.push({ nivel: "foco", texto: foco });
    const bons = it.filter((x) => x.nivel === "bom").length, atenc = it.filter((x) => x.nivel === "atencao").length;
    return { itens: it, foco, fala: `${bons} ${bons === 1 ? "ponto vai bem" : "pontos vão bem"} e ${atenc} ${atenc === 1 ? "pede atenção" : "pedem atenção"} esta semana. ${foco}` };
  }


  // ---------- mês e ano ----------
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const pad = (n) => String(n).padStart(2, "0");
  const nomeMes = (mes) => `${MESES[+mes.slice(5, 7) - 1]} de ${mes.slice(0, 4)}`;
  const somarMes = (mes, n) => { const d = new Date(+mes.slice(0, 4), +mes.slice(5, 7) - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  // Grade do mês começando na segunda (null = espaço vazio antes do dia 1).
  function diasDoMes(mes) {
    const a = +mes.slice(0, 4), m = +mes.slice(5, 7), n = new Date(a, m, 0).getDate(), lead = (new Date(a, m - 1, 1).getDay() + 6) % 7;
    return [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => `${mes}-${pad(i + 1)}`)];
  }
  const carga = (d, tarefas, dia) => { const t = tarefas.filter((x) => x.dia === dia); return { c: d.compromissos.filter((x) => x.data === dia).length, t: t.length, feitas: t.filter((x) => x.feita).length }; };
  function comMeta(d, m) { const x = JSON.parse(JSON.stringify(d)), texto = limpar(m.texto, 160); if (!texto) return { erro: "texto" }; x.metas.push({ id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), texto, escopo: m.escopo, ref: m.ref, feita: false }); return x; }
  const metasDe = (d, escopo, ref) => d.metas.filter((m) => m.escopo === escopo && m.ref === ref);
  // c = { d, tarefas, mes, hoje }
  function resumoMes(c) {
    const dias = diasDoMes(c.mes).filter(Boolean).map((dia) => ({ dia, ...carga(c.d, c.tarefas, dia) }));
    const comp = dias.reduce((s, x) => s + x.c, 0), tT = dias.reduce((s, x) => s + x.t, 0), tF = dias.reduce((s, x) => s + x.feitas, 0), metas = metasDe(c.d, "mes", c.mes);
    const livres = dias.filter((x) => x.dia >= c.hoje && !x.c && !x.t && ![0, 6].includes(deIso(x.dia).getDay())).length;
    const it = [{ nivel: "info", texto: comp ? `${plural(comp, "compromisso", "compromissos")} em ${MESES[+c.mes.slice(5, 7) - 1]}.` : `Nenhum compromisso marcado em ${MESES[+c.mes.slice(5, 7) - 1]}.` }];
    it.push(tT ? { nivel: tF / tT >= .7 ? "bom" : "info", texto: `Prioridades: ${tF} de ${tT} concluídas.` } : { nivel: "info", texto: "Nenhuma prioridade registrada no mês." });
    it.push(metas.length ? { nivel: metas.every((m) => m.feita) ? "bom" : "info", texto: `Metas do mês: ${metas.filter((m) => m.feita).length} de ${metas.length} cumpridas.` } : { nivel: "info", texto: "Sem metas do mês. Diga: meta do mês, vender mais clareamentos." });
    if (c.hoje.slice(0, 7) === c.mes) it.push({ nivel: "info", texto: `${plural(livres, "dia útil livre", "dias úteis livres")} daqui até o fim do mês.` });
    return { dias, itens: it, fala: `${nomeMes(c.mes)}: ${comp ? plural(comp, "compromisso", "compromissos") : "nenhum compromisso"}, ${tT ? tF + " de " + tT + " prioridades concluídas" : "nenhuma prioridade"} e ${metas.length ? metas.filter((m) => m.feita).length + " de " + plural(metas.length, "meta", "metas") + " cumpridas" : "nenhuma meta definida"}.` };
  }
  function resumoAno(c) {   // c = { d, tarefas, ano, hoje }
    const meses = Array.from({ length: 12 }, (_, i) => { const mes = `${c.ano}-${pad(i + 1)}`, r = diasDoMes(mes).filter(Boolean).map((dia) => carga(c.d, c.tarefas, dia)); return { mes, rotulo: MESES[i].slice(0, 3), c: r.reduce((s, x) => s + x.c, 0), t: r.reduce((s, x) => s + x.t, 0), feitas: r.reduce((s, x) => s + x.feitas, 0), metas: metasDe(c.d, "mes", mes).length }; });
    const metas = metasDe(c.d, "ano", String(c.ano)), comp = meses.reduce((s, x) => s + x.c, 0);
    return { meses, metas, fala: `Em ${c.ano}: ${comp ? plural(comp, "compromisso", "compromissos") : "nenhum compromisso"} marcado${comp === 1 ? "" : "s"} e ${metas.length ? metas.filter((m) => m.feita).length + " de " + plural(metas.length, "meta anual cumprida", "metas anuais cumpridas") : "nenhuma meta anual definida"}.` };
  }
  function montarMes(agora, mes) { const P = window.JarvisPessoal; return resumoMes({ d: dados, tarefas: P.ler().tarefas, mes: mes || iso(agora).slice(0, 7), hoje: iso(agora) }); }
  function montarAno(agora, ano) { const P = window.JarvisPessoal; return resumoAno({ d: dados, tarefas: P.ler().tarefas, ano: ano || agora.getFullYear(), hoje: iso(agora) }); }

  // Junta tudo que o Jarvis sabe (rotina, prioridades, leads, contas) no formato que resumoDia/feedbackSemana esperam.
  function montarDia(agora, dia) {
    const Ld = L(), F = window.JarvisFin, P = window.JarvisPessoal, hoje = iso(agora), alvo = dia || hoje;
    const r = Ld.resumo(Ld.lista()), pend = F.pendentes(F.lista(), agora, 7), h = agora.getHours();
    return { hoje: alvo, nome: ((P.ler().perfil.nome) || "Marcos").split(" ")[0], saudacao: h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite", hora: h,
      compromissos: doDia(dados.compromissos, alvo), tarefas: P.ler().tarefas.filter((t) => t.dia === alvo), retornos: (r.hoje || 0) + (r.semData || 0), atrasados: r.atrasados || 0,
      contas: pend.map((x) => ({ descricao: x.descricao || x.categoria, valor: x.valor, vencimento: x.vencimento || x.data, atrasada: !!x.atrasada })),
      agua: agua(dados, alvo), meta: dados.metaAgua, refeicoes: dados.refeicoes[alvo] || [],
      prefixo: alvo === hoje ? "Hoje você tem" : `${DOW[deIso(alvo).getDay()]} (${alvo.slice(8)}/${alvo.slice(5, 7)}) você tem`, vazio: alvo === hoje ? "Nenhum compromisso marcado para hoje." : `Nenhum compromisso marcado para ${DOW[deIso(alvo).getDay()].toLowerCase()} (${alvo.slice(8)}/${alvo.slice(5, 7)}).` };
  }
  function montarSemana(agora, ref) {
    const Ld = L(), F = window.JarvisFin, P = window.JarvisPessoal, hoje = iso(agora), tar = P.ler().tarefas, r = Ld.resumo(Ld.lista());
    const dias = semanaDe(ref || hoje).map((d) => ({ iso: d, rotulo: rotuloDia(d), compromissos: doDia(dados.compromissos, d), tarefasTotal: tar.filter((t) => t.dia === d).length, tarefasFeitas: tar.filter((t) => t.dia === d && t.feita).length, agua: agua(dados, d), refeicoes: (dados.refeicoes[d] || []).length }));
    return { hoje, dias, meta: dados.metaAgua, retornos: (r.hoje || 0) + (r.semData || 0), atrasados: r.atrasados || 0, ativos: r.ativos || 0,
      contas: F.pendentes(F.lista(), agora, 7).map((x) => ({ valor: x.valor, atrasada: !!x.atrasada })) };
  }
  window.JarvisRotina = { DOW, montarDia, montarSemana, montarMes, montarAno, resumoMes, resumoAno, diasDoMes, carga, comMeta, metasDe, nomeMes, somarMes, MESES, REFEICOES, KEY, ler, salvar, aoMudar, validar, lerHora, novoCompromisso, doDia, agua, comAgua, comRefeicao, semanaDe, rotuloDia, resumoDia, feedbackSemana, hhmm, iso, somar };
})();
