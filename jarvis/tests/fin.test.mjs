// node --test jarvis/tests/fin.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const win = {};
const ctx = vm.createContext({ window: win, TextDecoder, localStorage: undefined });
for (const f of ["modes.js", "contacts.js", "store.js", "leads.js", "fin.js", "brain.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
const F = win.JarvisFin, B = win.JarvisBrain, M = win.JARVIS_MODES;
const j = (x) => JSON.parse(JSON.stringify(x));
const NOV = new Date(2026, 10, 11, 10, 0);
const it = (t) => j(B.interpretar(t, M, NOV));

test("valores: vírgula, milhar, 'mil', R$", () => {
  assert.equal(F.lerValor("412,90"), 412.9); assert.equal(F.lerValor("R$ 1.250,50"), 1250.5);
  assert.equal(F.lerValor("2 mil"), 2000); assert.equal(F.lerValor("1,5 mil"), 1500); assert.equal(F.lerValor("300 reais"), 300);
  assert.equal(F.lerValor("sem número"), null);
});
test("categorias por palavra", () => {
  assert.equal(F.categorizar("conta de energia", "despesa"), "Energia");
  assert.equal(F.categorizar("resina e luvas", "despesa"), "Materiais");
  assert.equal(F.categorizar("anúncios Meta Ads", "despesa"), "Marketing");
  assert.equal(F.categorizar("algo estranho", "despesa"), "Outras despesas");
  assert.equal(F.categorizar("Unimed repasse", "receita"), "Convênios");
  assert.equal(F.categorizar("limpeza João", "receita"), "Consultas e procedimentos");
});
test("meses: este, passado, nome (sem ano = o mais recente já ocorrido)", () => {
  assert.equal(F.mesDeTexto("este mês", NOV), "2026-11"); assert.equal(F.mesDeTexto("mês passado", NOV), "2026-10");
  assert.equal(F.mesDeTexto("outubro", NOV), "2026-10"); assert.equal(F.mesDeTexto("dezembro", NOV), "2025-12");
  assert.equal(F.mesDeTexto("março de 2024", NOV), "2024-03"); assert.equal(F.mesDeTexto("sei lá", NOV), null);
  assert.equal(F.mesAnterior("2026-01"), "2025-12"); assert.equal(F.mesSeguinte("2026-12"), "2027-01"); assert.equal(F.nomeMes("2026-03"), "março de 2026");
});
const mk = (tipo, valor, desc, data, status = "pago", venc = "") => ({ ...F.novo({ tipo, valor, descricao: desc, data, status, vencimento: venc }, NOV) });
test("lançamento exige valor e tipo; pendente ganha vencimento", () => {
  assert.equal(F.novo({ tipo: "despesa", valor: 0 }, NOV).erro, "valor"); assert.equal(F.novo({ tipo: "x", valor: 5 }, NOV).erro, "tipo");
  const p = F.novo({ tipo: "despesa", valor: 100, descricao: "luz", status: "pendente", vencimento: "2026-11-20" }, NOV);
  assert.equal(p.status, "pendente"); assert.equal(p.vencimento, "2026-11-20"); assert.equal(p.categoria, "Energia");
});
test("resumo do mês: só o PAGO conta em receitas/despesas; pendente vai à parte; vs mês anterior", () => {
  const ls = [mk("receita", 5000, "consultas", "2026-11-03"), mk("receita", 800, "João", "2026-11-05", "pendente", "2026-11-20"),
    mk("despesa", 1200, "aluguel", "2026-11-02"), mk("despesa", 412.9, "energia", "2026-11-04", "pendente", "2026-11-09"), mk("despesa", 300, "resina", "2026-11-06"),
    mk("receita", 4000, "consultas", "2026-10-10"), mk("despesa", 1000, "aluguel", "2026-10-02")];
  const r = j(F.resumoMes(ls, "2026-11", NOV));
  assert.equal(r.receitas, 5000); assert.equal(r.despesas, 1500); assert.equal(r.saldo, 3500);
  assert.equal(r.aReceber, 800); assert.equal(r.aPagar, 412.9); assert.equal(r.atrasadas, 1);
  assert.equal(r.categorias[0].categoria, "Aluguel"); assert.equal(Math.round(r.vsAnterior.receitas * 100), 25); assert.equal(Math.round(r.vsAnterior.despesas * 100), 50);
});
test("contas a pagar: atrasadas e próximos dias, em ordem", () => {
  const ls = [mk("despesa", 10, "a", "2026-11-01", "pendente", "2026-11-09"), mk("despesa", 20, "b", "2026-11-01", "pendente", "2026-11-14"),
    mk("despesa", 30, "c", "2026-11-01", "pendente", "2026-12-30"), mk("despesa", 40, "d", "2026-11-01")];
  const p = j(F.pendentes(ls, NOV, 7));
  assert.deepEqual(p.map((x) => [x.descricao, x.atrasada]), [["a", true], ["b", false]]);
});
test("baixa de pendência entra no mês do pagamento e preserva a data original", () => {
  const pendente = mk("despesa", 189.9, "energia", "2026-10-15", "pendente", "2026-11-11");
  const pago = F.comPago(pendente, NOV);
  assert.equal(pago.data, "2026-11-11"); assert.equal(pago.dataOriginal, "2026-10-15");
  assert.equal(F.resumoMes([pago], "2026-10", NOV).despesas, 0);
  assert.equal(F.resumoMes([pago], "2026-11", NOV).despesas, 189.9);
});
test("CSV do mês: BOM, vírgula decimal, totais; relatório para o contador", () => {
  const ls = [mk("receita", 1500.5, "consultas", "2026-11-03"), mk("despesa", 300, "aluguel", "2026-11-02")];
  const c = F.csvMes(ls, "2026-11"); assert.ok(c.startsWith("﻿")); assert.match(c, /"1500,5"/); assert.match(c, /"Saldo";"1200,5"/);
  assert.match(F.relatorioTexto(ls, "2026-11"), /Fechamento de novembro de 2026[\s\S]*Saldo do mês: R\$\s?1\.200,50/);
});
test("voz: lançar despesa/receita, conta a vencer, pagar, resumo, fechar", () => {
  let r = it("lança despesa 412,90 energia"); assert.deepEqual([r.tipo, r.lanc.tipo, r.lanc.valor, r.lanc.descricao, r.lanc.status], ["fin_lancar", "despesa", 412.9, "energia", "pago"]);
  r = it("recebi 800 do João"); assert.deepEqual([r.lanc.tipo, r.lanc.valor, r.lanc.descricao], ["receita", 800, "João"]);
  r = it("paguei 300 de aluguel"); assert.deepEqual([r.lanc.tipo, r.lanc.status, r.lanc.descricao], ["despesa", "pago", "aluguel"]);
  r = it("conta de internet 189,90 vence dia 20"); assert.deepEqual([r.lanc.status, r.lanc.vencimento, r.lanc.descricao], ["pendente", "2026-11-20", "internet"]);
  r = it("lança despesa de material de resina"); assert.equal(r.erro, "valor");                      // falta o valor: o app pergunta
  r = it("paguei a energia"); assert.deepEqual([r.tipo, r.nome], ["fin_pagar", "energia"]);
  assert.equal(it("quanto gastei este mês").tipo, "fin_resumo"); assert.equal(it("resumo do mês passado").mes, "2026-10");
  assert.equal(it("contas a pagar").tipo, "fin_pendentes"); assert.equal(it("fecha o mês").tipo, "fin_fechar");
});
test("CRM e notas por voz", () => {
  assert.equal(it("abre o CRM").tipo, "crm_abrir"); assert.equal(it("fecha o CRM").tipo, "crm_fechar");
  let r = it("anota pro João: prefere sábado de manhã"); assert.deepEqual([r.tipo, r.nome, r.nota], ["lead_nota", "joao", "prefere sábado de manhã"]);
  r = it("o João vale 2 mil"); assert.deepEqual([r.tipo, r.valor], ["lead_valor", 2000]);
  assert.equal(it("detalhes do João").tipo, "lead_detalhe");
});
test("o prompt do Claude traz o modo, as regras e o pedido", () => {
  const p = B.montarPrompt({ modo: { nome: "Contador", instrucao: "Foque em finanças." }, texto: "como está o caixa?", contexto: "Receitas: R$ 5.000,00", historico: [{ quem: "voce", texto: "oi" }] });
  assert.match(p, /Modo ativo: Contador/); assert.match(p, /NÃO executa nada/); assert.match(p, /PEDIDO DO USUÁRIO: como está o caixa\?/); assert.match(p, /Usuário: oi/);
});

// ---------- Contador 2.0: evolução, fixas, conferência ----------
test("evolução: 6 meses terminando no mês pedido, só o pago, virando o ano", () => {
  const ls = [mk("receita", 1000, "a", "2026-11-03"), mk("despesa", 400, "b", "2026-11-04"), mk("receita", 500, "c", "2026-09-10"), mk("despesa", 50, "d", "2026-09-11", "pendente", "2026-09-30"), mk("receita", 700, "e", "2026-06-01")];
  const s = j(F.serieMeses(ls, "2026-11", 6));
  assert.deepEqual(s.map((x) => x.mes), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(s.map((x) => x.rotulo), ["jun", "jul", "ago", "set", "out", "nov"]);
  assert.deepEqual([s[5].receitas, s[5].despesas, s[5].saldo], [1000, 400, 600]);
  assert.deepEqual([s[3].receitas, s[3].despesas], [500, 0]);            // o pendente de setembro não conta
  assert.equal(s[0].receitas, 700); assert.equal(s[4].qtd, 0);
  assert.deepEqual(j(F.serieMeses([], "2026-02", 3)).map((x) => x.mes), ["2025-12", "2026-01", "2026-02"]);
});
test("despesa fixa: valida, usa o último dia do mês e NÃO duplica ao lançar de novo", () => {
  assert.equal(F.novaFixa({ descricao: "Aluguel", valor: 0 }).erro, "valor"); assert.equal(F.novaFixa({ descricao: " ", valor: 10 }).erro, "descricao");
  const a = j(F.novaFixa({ descricao: "Aluguel", valor: 2800, dia: 5 })), b = j(F.novaFixa({ descricao: "Internet", valor: 189.9, dia: 31 }));
  assert.deepEqual([a.tipo, a.categoria, a.dia, a.ativa], ["fixa", "Aluguel", 5, true]); assert.equal(b.categoria, "Internet e telefone");
  const novos = j(F.lancarFixas([a, b], [], "2026-02", NOV));
  assert.equal(novos.length, 2); assert.equal(novos[0].data, "2026-02-05"); assert.equal(novos[1].data, "2026-02-28");   // fevereiro não tem 31
  assert.ok(novos.every((x) => x.status === "pendente" && x.tipo === "despesa" && x.vencimento === x.data));
  // o aluguel já foi lançado e pago: lançar de novo só cria o que falta e não mexe no pago
  const pago = { ...novos[0], status: "pago" };
  const de_novo = j(F.lancarFixas([a, b], [pago], "2026-02", NOV)); assert.deepEqual(de_novo.map((x) => x.descricao), ["Internet"]);
  assert.deepEqual(j(F.lancarFixas([{ ...a, ativa: false }], [], "2026-02", NOV)), []);                                      // desativada não lança
  assert.equal(j(F.lancarFixas([a], [], "2026-03", NOV))[0].id !== novos[0].id, true);                                      // mês diferente = lançamento diferente
});
test("conferência: alertas impedem 'pronto'; avisos informativos não", () => {
  const ok = [mk("receita", 5000, "consultas", "2026-10-03"), mk("despesa", 300, "aluguel", "2026-10-04")];
  assert.deepEqual(j(F.conferencia(ok, "2026-10", NOV)), { itens: [], pronto: true });
  const c = j(F.conferencia([mk("despesa", 100, "coisa estranha", "2026-10-04"), mk("despesa", 50, "luz", "2026-10-05", "pendente", "2026-10-09")], "2026-10", NOV));
  assert.equal(c.pronto, false);
  const textos = c.itens.map((i) => i.texto).join("|");
  assert.match(textos, /Nenhuma receita/); assert.match(textos, /1 conta atrasada/); assert.match(textos, /Outras despesas/);
  assert.match(j(F.conferencia(ok, "2026-11", NOV)).itens.map((i) => i.texto).join("|"), /Nenhuma receita|ainda não terminou/);   // mês corrente: aviso
  assert.equal(j(F.conferencia([], "2026-10", NOV)).itens[0].texto, "Nenhum lançamento neste mês.");
  // mudou depois de fechar
  const fech = { receitas: 5000, despesas: 300 }; assert.equal(F.conferencia(ok, "2026-10", NOV, fech).pronto, true);
  const mudou = j(F.conferencia([...ok, mk("despesa", 10, "x", "2026-10-06")], "2026-10", NOV, fech)); assert.match(mudou.itens.map((i) => i.texto).join("|"), /mudaram desde o último fechamento/);
});
test("cor de categoria é estável e diferente entre categorias", () => {
  assert.equal(F.corCategoria("Aluguel"), F.corCategoria("Aluguel")); assert.notEqual(F.corCategoria("Aluguel"), F.corCategoria("Energia"));
  assert.match(F.corCategoria("Categoria nova"), /^#[0-9a-f]{6}$/);
});

test("voz: despesas fixas (cadastrar e lançar no mês)", () => {
  let r = it("cadastra despesa fixa aluguel 2800 dia 5"); assert.deepEqual([r.tipo, r.fixa.descricao, r.fixa.valor, r.fixa.dia], ["fin_fixa_nova", "aluguel", 2800, 5]);
  r = it("lança despesa fixa internet 189,90"); assert.deepEqual([r.tipo, r.fixa.valor, r.fixa.dia], ["fin_fixa_nova", 189.9, 1]);
  assert.equal(it("cadastra despesa fixa aluguel").erro, "valor");
  assert.equal(it("lança as fixas do mês").tipo, "fin_fixas"); assert.equal(it("lança as despesas fixas do mês passado").mes, "2026-10");
  assert.equal(it("lança despesa 412,90 energia").tipo, "fin_lancar");                   // não confunde com lançamento comum
});
