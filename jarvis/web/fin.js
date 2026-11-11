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
  const comPago = (l, agora) => ({ ...l, status: "pago", vencimento: "", data: l.data > L().iso(agora || new Date()) ? L().iso(agora || new Date()) : l.data });

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

  const store = window.JarvisStore.criar({ colecao: "fin", chaveLocal: "jarvis_fin_v1" });
  const lancs = () => store.lista().filter(ehLanc);
  const fechamentos = () => store.lista().filter((x) => x.tipo === "fechamento");

  window.JarvisFin = {
    CATEGORIAS, categorizar, brl, lerValor, mesDe, mesAnterior, mesSeguinte, nomeMes, mesDeTexto,
    novo, doMes, resumoMes, pendentes, comPago, csvMes, relatorioTexto, ehLanc,
    iniciar: store.iniciar, salvar: store.salvar, remover: store.remover, aoMudar: store.aoMudar,
    lista: lancs, fechamentos, porId: store.porId,
    fechamentoDe: (mes) => fechamentos().find((f) => f.mes === mes) || null,
    // Registra o fechamento do mês (foto dos totais no momento).
    async fecharMes(mes, agora) {
      const r = resumoMes(lancs(), mes, agora);
      return store.salvar({ id: "f" + mes, tipo: "fechamento", mes, receitas: r.receitas, despesas: r.despesas, saldo: r.saldo, aPagar: r.aPagar, aReceber: r.aReceber, qtd: r.qtd, fechadoEm: (agora || new Date()).toISOString() });
    },
    get modo() { return store.modo; }, get aviso() { return store.aviso; },
  };
})();
