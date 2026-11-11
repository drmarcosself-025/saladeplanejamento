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
