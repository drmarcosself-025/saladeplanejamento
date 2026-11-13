// Financeiro (modo Contador): lançamentos, resumo mensal, contas a pagar e
// fechamento do mês. Dinheiro em número (reais) e datas "AAAA-MM-DD".
// REGRAS: "Receitas" e "Despesas" do resumo contam só o que foi PAGO/RECEBIDO;
// o que está pendente aparece à parte ("a pagar", "a receber").
// Parte pura testável em Node; armazenamento vem de store.js.
(function () {
  const L = () => window.JarvisLeads;       // datas: iso, somar, dataDe
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const arred = (n) => Math.round(n * 100) / 100;

  const CATEGORIAS = {
    receita: ["Consultas e procedimentos", "Convênios", "Outras receitas"],
    despesa: ["Aluguel", "Energia", "Água", "Internet e telefone", "Materiais", "Laboratório", "Folha e pró-labore", "Impostos", "Marketing", "Equipamentos", "Software", "Contador", "Outras despesas"],
  };
  const PALAVRAS = [
    ["Aluguel", /\b(aluguel|condominio)\b/], ["Energia", /\b(energia|luz|equatorial|celpa|enel|cemig)\b/], ["Água", /\b(agua|saneamento|saae)\b/],
    ["Internet e telefone", /\b(internet|telefone|celular|vivo|claro|tim|fibra|wi ?fi)\b/], ["Materiais", /\b(material|materiais|resina|luva|luvas|anestesico|descartavel|descartaveis|insumo|insumos|limpeza)\b/],
    ["Laboratório", /\b(laboratorio|protetico|proteticos)\b/], ["Folha e pró-labore", /\b(salario|salarios|folha|pro labore|prolabore|funcionario|funcionaria|secretaria|auxiliar|comissao|13)\b/],
    ["Impostos", /\b(imposto|impostos|das|simples|iss|irpf|irpj|inss|fgts|darf|taxa|alvara)\b/], ["Marketing", /\b(anuncio|anuncios|trafego|meta ads|google ads|marketing|impulsionamento|design|designer|social media)\b/],
    ["Equipamentos", /\b(equipamento|equipamentos|compressor|autoclave|cadeira|aparelho|motor|fotopolimerizador)\b/], ["Software", /\b(software|clinicorp|sistema|assinatura|licenca|app)\b/],
    ["Contador", /\b(contador|contabil|contabilidade)\b/],
  ];
  const PALAVRAS_REC = [["Convênios", /\b(convenio|convenios|plano|unimed|amil|odontoprev|bradesco saude)\b/]];
  function categorizar(desc, tipo) {
    const t = norm(desc);
    for (const [c, re] of (tipo === "receita" ? PALAVRAS_REC : PALAVRAS)) if (re.test(t)) return c;
    return tipo === "receita" ? "Consultas e procedimentos" : "Outras despesas";
  }

  // ---------- valores e meses ----------
  const brl = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // "412,90" · "1.500,00" · "2 mil" · "1,5 mil" · "R$ 300" → número (ou null)
  function lerValor(txt) {
    const s = String(txt || "").toLowerCase();
    let m = s.match(/(\d+(?:[.,]\d+)?)\s*mil\b/);
    if (m) return arred(parseFloat(m[1].replace(",", ".")) * 1000);
    m = s.match(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?)/);
    if (m) return parseFloat(m[1].replace(/\./g, "").replace(",", "."));
    m = s.match(/(\d+,\d{1,2})(?!\d)/);
    if (m) return parseFloat(m[1].replace(",", "."));
    m = s.match(/(\d+\.\d{1,2})(?!\d)/);
    if (m) return parseFloat(m[1]);
    m = s.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const mesDe = (isoStr) => String(isoStr || "").slice(0, 7);
  function mesAnterior(m) { const [a, n] = m.split("-").map(Number); return n === 1 ? `${a - 1}-12` : `${a}-${String(n - 1).padStart(2, "0")}`; }
  function mesSeguinte(m) { const [a, n] = m.split("-").map(Number); return n === 12 ? `${a + 1}-01` : `${a}-${String(n + 1).padStart(2, "0")}`; }
  const nomeMes = (m) => { const [a, n] = m.split("-").map(Number); const x = MESES[n - 1]; return `${x === "marco" ? "março" : x} de ${a}`; };
  // "este mês", "mês passado", "outubro", "outubro de 2025" → "AAAA-MM" (ou null)
  function mesDeTexto(texto, agora) {
    const t = norm(texto), atual = mesDe(L().iso(agora || new Date()));
    if (/\b(mes passado|ultimo mes|mes anterior)\b/.test(t)) return mesAnterior(atual);
    if (/\b(este mes|mes atual|esse mes|do mes|no mes|agora)\b/.test(t)) return atual;
    const m = t.match(/\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(\d{4}))?/);
    if (!m) return null;
    const n = MESES.indexOf(m[1]) + 1, anoAtual = +atual.slice(0, 4), mesAt = +atual.slice(5, 7);
    const ano = m[2] ? +m[2] : (n > mesAt ? anoAtual - 1 : anoAtual);     // sem ano: o mês mais recente já ocorrido
    return `${ano}-${String(n).padStart(2, "0")}`;
  }

  // ---------- lançamentos ----------
  const novoId = () => "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ehLanc = (x) => x && (x.tipo === "receita" || x.tipo === "despesa");
  // Cria um lançamento ou { erro }.
  function novo(d, agora) {
    agora = agora || new Date();
    const valor = typeof d.valor === "number" ? arred(d.valor) : null;
    if (!(valor > 0)) return { erro: "valor" };
    if (d.tipo !== "receita" && d.tipo !== "despesa") return { erro: "tipo" };
    const hoje = L().iso(agora), descricao = String(d.descricao || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const status = d.status === "pendente" ? "pendente" : "pago";
    return {
      id: novoId(), tipo: d.tipo, valor, descricao,
      categoria: d.categoria || categorizar(descricao, d.tipo),
      data: d.data || hoje, status, vencimento: status === "pendente" ? (d.vencimento || d.data || hoje) : "",
      criado: agora.toISOString(),
    };
  }
  const doMes = (ls, mes) => ls.filter((l) => ehLanc(l) && mesDe(l.data) === mes);
  const soma = (ls) => arred(ls.reduce((s, l) => s + l.valor, 0));

  function resumoMes(ls, mes, agora) {
    const itens = doMes(ls, mes);
    const rec = itens.filter((l) => l.tipo === "receita"), des = itens.filter((l) => l.tipo === "despesa");
    const receitas = soma(rec.filter((l) => l.status === "pago")), despesas = soma(des.filter((l) => l.status === "pago"));
    const aReceber = soma(rec.filter((l) => l.status === "pendente")), aPagar = soma(des.filter((l) => l.status === "pendente"));
    const porCat = {};
    for (const l of des) porCat[l.categoria] = arred((porCat[l.categoria] || 0) + l.valor);
    const totalCat = Object.values(porCat).reduce((a, b) => a + b, 0) || 1;
    const categorias = Object.entries(porCat).map(([categoria, total]) => ({ categoria, total, pct: total / totalCat })).sort((a, b) => b.total - a.total);
    const ant = mesAnterior(mes), itensAnt = doMes(ls, ant);
    const recAnt = soma(itensAnt.filter((l) => l.tipo === "receita" && l.status === "pago")), desAnt = soma(itensAnt.filter((l) => l.tipo === "despesa" && l.status === "pago"));
    const var_ = (a, b) => (b > 0 ? (a - b) / b : null);
    const hoje = L().iso(agora || new Date());
    return {
      mes, qtd: itens.length, receitas, despesas, saldo: arred(receitas - despesas), aReceber, aPagar,
      resultadoPrevisto: arred(receitas + aReceber - despesas - aPagar),
      categorias, maiorCategoria: categorias[0] || null,
      vsAnterior: { receitas: var_(receitas, recAnt), despesas: var_(despesas, desAnt), recAnt, desAnt },
      paraRevisar: des.filter((l) => l.categoria === "Outras despesas").length,
      atrasadas: des.filter((l) => l.status === "pendente" && l.vencimento && l.vencimento < hoje).length,
    };
  }
  // Despesas pendentes: atrasadas e as que vencem nos próximos `dias` dias.
  function pendentes(ls, agora, dias) {
    const hoje = L().iso(agora || new Date()), lim = L().somar(hoje, dias == null ? 7 : dias);
    return ls.filter((l) => ehLanc(l) && l.tipo === "despesa" && l.status === "pendente" && (l.vencimento || l.data) <= lim)
      .map((l) => ({ ...l, atrasada: (l.vencimento || l.data) < hoje }))
      .sort((a, b) => (a.vencimento || a.data).localeCompare(b.vencimento || b.data));
  }
  // A baixa pertence ao mês em que houve pagamento, sem perder a data original.
  const comPago = (l, agora) => {
    const dataPagamento = L().iso(agora || new Date());
    return { ...l, status: "pago", vencimento: "", dataOriginal: l.dataOriginal || l.data, data: dataPagamento, pagoEm: dataPagamento };
  };

  // ---------- exportação ----------
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const num = (v) => String(v).replace(".", ",");
  function csvMes(ls, mes) {
    const itens = doMes(ls, mes).sort((a, b) => a.data.localeCompare(b.data));
    const cab = ["Data", "Tipo", "Categoria", "Descrição", "Valor", "Situação", "Vencimento"];
    const linhas = itens.map((l) => [l.data, l.tipo === "receita" ? "Receita" : "Despesa", l.categoria, l.descricao, num(l.valor), l.status === "pago" ? (l.tipo === "receita" ? "Recebido" : "Pago") : "Pendente", l.vencimento].map(q).join(";"));
    const r = resumoMes(ls, mes);
    const tot = [["", "", "", "Receitas (recebidas)", num(r.receitas)], ["", "", "", "Despesas (pagas)", num(r.despesas)], ["", "", "", "Saldo", num(r.saldo)], ["", "", "", "A pagar", num(r.aPagar)], ["", "", "", "A receber", num(r.aReceber)]].map((x) => x.map(q).join(";"));
    return "﻿" + [cab.map(q).join(";"), ...linhas, "", ...tot].join("\r\n") + "\r\n";
  }
  // Texto pronto para colar numa conversa com o contador.
  function relatorioTexto(ls, mes) {
    const r = resumoMes(ls, mes), pct = (v) => (v == null ? "sem base" : (v >= 0 ? "+" : "") + Math.round(v * 100) + "%");
    const linhas = [`Fechamento de ${nomeMes(mes)}`, "",
      `Receitas recebidas: ${brl(r.receitas)} (${pct(r.vsAnterior.receitas)} vs mês anterior)`,
      `Despesas pagas: ${brl(r.despesas)} (${pct(r.vsAnterior.despesas)} vs mês anterior)`,
      `Saldo do mês: ${brl(r.saldo)}`, `A pagar: ${brl(r.aPagar)} · A receber: ${brl(r.aReceber)}`, "", "Despesas por categoria:"];
    for (const c of r.categorias) linhas.push(`- ${c.categoria}: ${brl(c.total)} (${Math.round(c.pct * 100)}%)`);
    if (r.paraRevisar) linhas.push("", `Atenção: ${r.paraRevisar} despesa(s) em "Outras despesas" precisam de categoria.`);
    return linhas.join("\n");
  }


  // ---------- evolução, despesas fixas e conferência (Contador 2.0) ----------
  const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const ultimoDia = (mes) => { const [a, m] = mes.split("-").map(Number); return new Date(a, m, 0).getDate(); };
  // Últimos `n` meses terminando em `mesFinal`: o que entrou, o que saiu e o saldo de cada um (só o PAGO/RECEBIDO).
  function serieMeses(ls, mesFinal, n) {
    n = n || 6; const seq = []; let m = mesFinal;
    for (let i = 0; i < n; i++) { seq.unshift(m); m = mesAnterior(m); }
    return seq.map((mes) => {
      const it = doMes(ls, mes), receitas = soma(it.filter((l) => l.tipo === "receita" && l.status === "pago")), despesas = soma(it.filter((l) => l.tipo === "despesa" && l.status === "pago"));
      return { mes, rotulo: MESES_CURTOS[+mes.slice(5, 7) - 1], receitas, despesas, saldo: arred(receitas - despesas), qtd: it.length };
    });
  }
  // Despesa fixa = se repete todo mês (aluguel, salário, internet...). Fica cadastrada uma vez.
  const ehFixa = (x) => x && x.tipo === "fixa";
  function novaFixa(d) {
    const valor = typeof d.valor === "number" ? arred(d.valor) : null, descricao = String(d.descricao || "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!(valor > 0)) return { erro: "valor" };
    if (!descricao) return { erro: "descricao" };
    const dia = Math.max(1, Math.min(31, parseInt(d.dia, 10) || 1));
    return { id: "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), tipo: "fixa", descricao, valor, dia, categoria: d.categoria || categorizar(descricao, "despesa"), ativa: true, criado: new Date().toISOString() };
  }
  // Lançamentos que FALTAM no mês. O id inclui a fixa e o mês: rodar de novo não duplica nem apaga o que já foi pago.
  function lancarFixas(fixas, existentes, mes, agora) {
    const ids = new Set(existentes.map((l) => l.id)), out = [];
    for (const f of fixas.filter((x) => x.ativa !== false)) {
      const id = `lf-${f.id}-${mes}`; if (ids.has(id)) continue;
      const data = `${mes}-${String(Math.min(f.dia, ultimoDia(mes))).padStart(2, "0")}`;
      out.push({ id, tipo: "despesa", valor: f.valor, descricao: f.descricao, categoria: f.categoria, data, status: "pendente", vencimento: data, fixa: f.id, criado: (agora || new Date()).toISOString() });
    }
    return out;
  }
  // O que conferir antes de fechar o mês. `pronto` = sem nenhum alerta (os avisos "info" não impedem).
  function conferencia(ls, mes, agora, fechamento) {
    agora = agora || new Date();
    const hoje = L().iso(agora), r = resumoMes(ls, mes, agora), it = doMes(ls, mes), itens = [];
    if (!it.length) itens.push({ nivel: "alerta", texto: "Nenhum lançamento neste mês." });
    else if (!it.some((l) => l.tipo === "receita")) itens.push({ nivel: "alerta", texto: "Nenhuma receita lançada." });
    if (r.atrasadas) itens.push({ nivel: "alerta", texto: `${r.atrasadas} conta${r.atrasadas > 1 ? "s atrasadas" : " atrasada"}: pague ou ajuste o vencimento.` });
    const pend = it.filter((l) => l.status === "pendente").length - r.atrasadas;
    if (pend > 0) itens.push({ nivel: "info", texto: `${pend} lançamento${pend > 1 ? "s ainda pendentes" : " ainda pendente"}: fica${pend > 1 ? "m" : ""} fora do saldo pago.` });
    if (r.paraRevisar) itens.push({ nivel: "alerta", texto: `${r.paraRevisar} despesa${r.paraRevisar > 1 ? "s" : ""} em "Outras despesas": defina a categoria.` });
    if (mes === mesDe(hoje) && +hoje.slice(8) < ultimoDia(mes)) itens.push({ nivel: "info", texto: "O mês ainda não terminou." });
    if (mes > mesDe(hoje)) itens.push({ nivel: "info", texto: "Este é um mês futuro." });
    if (fechamento && (fechamento.receitas !== r.receitas || fechamento.despesas !== r.despesas)) itens.push({ nivel: "alerta", texto: "Os valores mudaram desde o último fechamento. Atualize o fechamento." });
    return { itens, pronto: !itens.some((i) => i.nivel === "alerta") };
  }
  // Cor estável de cada categoria nos gráficos.
  const PALETA = ["#7fd6c2", "#8fb6ff", "#ffb86b", "#ff8fa3", "#c4a7ff", "#9be37f", "#ffd76b", "#6fd0ff", "#f59ad8", "#b8c4d0", "#e7a37a", "#7ee0a8", "#a1b7ff"];
  const corCategoria = (cat) => { const i = [...CATEGORIAS.despesa, ...CATEGORIAS.receita].indexOf(cat); return PALETA[(i < 0 ? cat.length : i) % PALETA.length]; };

  const store = window.JarvisStore.criar({ colecao: "fin", chaveLocal: "jarvis_fin_v1" });
  const lancs = () => store.lista().filter(ehLanc);
  const fechamentos = () => store.lista().filter((x) => x.tipo === "fechamento");
  const fixas = () => store.lista().filter(ehFixa);

  window.JarvisFin = {
    CATEGORIAS, categorizar, brl, lerValor, mesDe, mesAnterior, mesSeguinte, nomeMes, mesDeTexto,
    novo, doMes, resumoMes, pendentes, comPago, csvMes, relatorioTexto, ehLanc,
    iniciar: store.iniciar, salvar: store.salvar, remover: store.remover, aoMudar: store.aoMudar,
    lista: lancs, fechamentos, fixas, porId: store.porId,
    MESES_CURTOS, ultimoDia, serieMeses, novaFixa, lancarFixas, conferencia, corCategoria,
    fechamentoDe: (mes) => fechamentos().find((f) => f.mes === mes) || null,
    // Registra o fechamento do mês (foto dos totais no momento).
    async fecharMes(mes, agora) {
      const r = resumoMes(lancs(), mes, agora);
      return store.salvar({ id: "f" + mes, tipo: "fechamento", mes, receitas: r.receitas, despesas: r.despesas, saldo: r.saldo, aPagar: r.aPagar, aReceber: r.aReceber, qtd: r.qtd, fechadoEm: (agora || new Date()).toISOString() });
    },
    get modo() { return store.modo; }, get aviso() { return store.aviso; },
  };
})();
