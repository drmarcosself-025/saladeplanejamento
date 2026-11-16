// node --test jarvis/tests/rotina.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const win = {};
const ctx = vm.createContext({ window: win, TextDecoder, localStorage: undefined });
for (const f of ["modes.js", "contacts.js", "store.js", "leads.js", "fin.js", "rotina.js", "brain.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
const R = win.JarvisRotina, B = win.JarvisBrain, M = win.JARVIS_MODES;
const j = (x) => JSON.parse(JSON.stringify(x));
const SEX = new Date(2026, 10, 13, 10, 0);          // sexta, 13/11/2026
const it = (t) => j(B.interpretar(t, M, SEX));

test("hora por extenso e numérica", () => {
  assert.equal(R.lerHora("reunião às 14h"), "14:00"); assert.equal(R.lerHora("dentista 9h30"), "09:30"); assert.equal(R.lerHora("às 15:45"), "15:45");
  assert.equal(R.lerHora("meio dia"), "12:00"); assert.equal(R.lerHora("às 9"), "09:00"); assert.equal(R.lerHora("sem hora"), null); assert.equal(R.lerHora("às 25h"), null);
});
test("semana vai de segunda a domingo e dá a volta no mês", () => {
  assert.deepEqual(j(R.semanaDe("2026-11-13")), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.equal(R.semanaDe("2026-11-15")[0], "2026-11-09"); assert.equal(R.semanaDe("2026-12-02")[6], "2026-12-06"); assert.equal(R.semanaDe("2026-11-30")[0], "2026-11-30");
});
test("compromissos ordenados por hora; água e refeições", () => {
  const a = R.novoCompromisso({ titulo: "B", data: "2026-11-13", hora: "15:00" }), b = R.novoCompromisso({ titulo: "A", data: "2026-11-13", hora: "09:00" }), c = R.novoCompromisso({ titulo: "Sem hora", data: "2026-11-13" });
  assert.deepEqual(R.doDia([a, c, b], "2026-11-13").map((x) => x.titulo), ["A", "B", "Sem hora"]); assert.equal(R.novoCompromisso({ titulo: " " }).erro, "titulo");
  let d = R.ler(); d = R.comAgua(d, 3, "2026-11-13"); d = R.comAgua(d, 2, "2026-11-13"); assert.equal(R.agua(d, "2026-11-13"), 5); assert.equal(R.agua(R.comAgua(d, -99, "2026-11-13"), "2026-11-13"), 0);
  d = R.comRefeicao(d, "almoco", "2026-11-13"); d = R.comRefeicao(d, "almoco", "2026-11-13", true); assert.deepEqual(j(d.refeicoes["2026-11-13"]), ["almoco"]);
  d = R.comRefeicao(d, "almoco", "2026-11-13"); assert.deepEqual(j(d.refeicoes["2026-11-13"]), []);
  assert.deepEqual(j(R.validar({ agua: { "2026-11-13": 999, ruim: 3 }, refeicoes: { "2026-11-13": ["cafe", "pizza"] }, compromissos: [{ id: "x", titulo: "t", data: "lixo" }] })).agua, { "2026-11-13": 40 });
});
test("resumo do dia: fala curta e itens", () => {
  const r = R.resumoDia({ hoje: "2026-11-13", nome: "Marcos", saudacao: "Bom dia", hora: 9, compromissos: [{ titulo: "Dentista", hora: "09:30", feito: false }], tarefas: [{ texto: "Ligar contador", feita: false }, { texto: "X", feita: true }], retornos: 2, atrasados: 1, contas: [{ descricao: "Energia", valor: 412.9, vencimento: "2026-11-20", atrasada: false }], agua: 2, meta: 8, refeicoes: ["cafe"] });
  assert.match(r.fala, /^Bom dia, Marcos\. Hoje você tem 1 compromisso, o primeiro às 9h30: Dentista\./); assert.match(r.fala, /1 prioridade pendente, 3 retornos de leads, 1 conta para pagar/);
  assert.ok(r.itens.includes("09h30 · Dentista") || r.itens.some((x) => /Dentista/.test(x))); assert.ok(r.itens.includes("Água: 2 de 8 copos"));
  assert.match(R.resumoDia({ hoje: "x", nome: "M", hora: 9, compromissos: [], tarefas: [], retornos: 0, atrasados: 0, contas: [], agua: 0, meta: 8, refeicoes: [] }).fala, /Nenhum compromisso marcado para hoje\. Sem pendências/);
});
test("feedback da semana: pontos bons, atenção e foco", () => {
  const dias = R.semanaDe("2026-11-13").map((iso, i) => ({ iso, compromissos: i === 4 ? [{ feito: false }] : [], tarefasTotal: i < 3 ? 2 : 0, tarefasFeitas: i < 3 ? 2 : 0, agua: i < 4 ? 8 : 0, refeicoes: i < 4 ? 3 : 0 }));
  const f = R.feedbackSemana({ hoje: "2026-11-13", dias, meta: 8, retornos: 0, atrasados: 2, ativos: 5, contas: [{ valor: 100, atrasada: true }] });
  const txt = f.itens.map((x) => x.texto).join("|");
  assert.match(txt, /1 compromisso na semana; 1 ainda por vir/); assert.match(txt, /6 de 6 concluídas \(100%\)/); assert.match(txt, /2 atrasados/); assert.match(txt, /Água: média de 8,0/); assert.match(txt, /4 de 5 dias com 3 refeições/);
  assert.equal(f.foco, "Comece pelos retornos atrasados de leads."); assert.match(f.fala, /pedem atenção|pede atenção/);
  const ok = R.feedbackSemana({ hoje: "2026-11-13", dias, meta: 8, retornos: 0, atrasados: 0, ativos: 0, contas: [] });
  assert.equal(ok.foco, "A semana está em dia. Bom momento para planejar a próxima.");
});
test("voz: saudação, dia, semana e amanhã", () => {
  assert.deepEqual([it("bom dia").tipo, it("bom dia").saudacao], ["rot_dia", true]); assert.equal(it("Jarvis, boa tarde").tipo, "rot_dia");
  for (const f of ["como está minha semana", "resumo da semana", "me passa o feedback da semana", "organiza minha semana", "abre minha semana"]) assert.equal(it(f).tipo, "rot_semana", f);
  for (const f of ["resumo do dia", "como está meu dia", "o que tenho hoje", "minha agenda", "o que eu tenho que fazer hoje"]) assert.equal(it(f).tipo, "rot_dia", f);
  assert.deepEqual([it("o que tenho amanhã").tipo, it("o que tenho amanhã").quando], ["rot_dia", "amanha"]);
  assert.equal(it("ativa o agente dia a dia").tipo, "ativar"); assert.equal(it("meu dia").tipo, "ativar");
});
test("voz: água e refeições", () => {
  assert.deepEqual([it("bebi um copo de água").tipo, it("bebi um copo de água").n], ["rot_agua", 1]); assert.equal(it("tomei 3 copos de água").n, 3); assert.equal(it("bebi 500 ml de água").n, 2);
  assert.equal(it("bebi uma garrafa de água").n, 2); assert.equal(it("quanta água eu bebi hoje").tipo, "rot_agua_status");
  assert.equal(it("almocei").refeicao, "almoco"); assert.equal(it("jantei").refeicao, "jantar"); assert.equal(it("tomei café da manhã").refeicao, "cafe"); assert.equal(it("comi uma salada").tipo, "rot_refeicao");
});
test("voz: tarefas e compromissos", () => {
  let r = it("adiciona tarefa ligar para o contador"); assert.deepEqual([r.tipo, r.tarefa, r.dia], ["rot_tarefa", "Ligar para o contador", "2026-11-13"]);
  r = it("nova tarefa pagar imposto amanhã"); assert.deepEqual([r.tarefa, r.dia], ["Pagar imposto", "2026-11-14"]);
  r = it("concluí a tarefa ligar para o contador"); assert.deepEqual([r.tipo, r.nome], ["rot_tarefa_feita", "ligar para o contador"]);
  r = it("marca reunião com a contadora amanhã às 14h"); assert.deepEqual([r.tipo, r.titulo, r.data, r.hora], ["rot_compromisso", "Reunião com a contadora", "2026-11-14", "14:00"]);
  r = it("agenda dentista dia 20 às 9h30"); assert.deepEqual([r.titulo, r.data, r.hora], ["Dentista", "2026-11-20", "09:30"]);
  r = it("anota consulta segunda às 8h"); assert.deepEqual([r.tipo, r.data, r.hora], ["rot_compromisso", "2026-11-16", "08:00"]);
  assert.notEqual(it("marca o João como interessado").tipo, "rot_compromisso");     // isso é lead
  assert.equal(it("lança despesa 412,90 energia").tipo, "fin_lancar"); assert.equal(it("quem preciso retornar hoje").tipo.startsWith("lead"), true);
});
test("mês, ano e metas: grade, contagens e voz de planejamento", () => {
  const g = j(R.diasDoMes("2026-11")); assert.equal(g.length, 6 + 30); assert.deepEqual(g.slice(0, 7), [null, null, null, null, null, null, "2026-11-01"]); assert.equal(R.nomeMes("2026-11"), "novembro de 2026"); assert.equal(R.somarMes("2026-12", 1), "2027-01");
  let d = R.ler(); d.compromissos.push(R.novoCompromisso({ titulo: "A", data: "2026-11-20", hora: "09:00" }), R.novoCompromisso({ titulo: "B", data: "2026-11-20" })); d = R.comMeta(d, { texto: "Vender mais clareamentos", escopo: "mes", ref: "2026-11" }); d = R.comMeta(d, { texto: "Abrir segunda sala", escopo: "ano", ref: "2026" });
  assert.equal(R.comMeta(d, { texto: " ", escopo: "mes", ref: "2026-11" }).erro, "texto"); d = R.validar(d); assert.equal(R.metasDe(d, "mes", "2026-11").length, 1);
  const tarefas = [{ id: "1", texto: "x", dia: "2026-11-20", feita: true }, { id: "2", texto: "y", dia: "2026-11-21", feita: false }];
  const m = R.resumoMes({ d, tarefas, mes: "2026-11", hoje: "2026-11-16" }); assert.match(m.fala, /novembro de 2026: 2 compromissos, 1 de 2 prioridades concluídas e 0 de 1 meta cumpridas/);
  assert.ok(m.itens.some((x) => /dias úteis livres/.test(x.texto)));
  const a = R.resumoAno({ d, tarefas, ano: 2026, hoje: "2026-11-16" }); assert.equal(a.meses.length, 12); assert.deepEqual([a.meses[10].c, a.meses[10].t, a.meses[10].feitas, a.meses[10].metas], [2, 2, 1, 1]); assert.match(a.fala, /2 compromissos marcados e 0 de 1 meta anual cumprida/);
});
test("voz: dia específico, mês, ano e metas", () => {
  let r = it("o que tenho segunda"); assert.deepEqual([r.tipo, r.data], ["rot_dia", "2026-11-16"]); r = it("o que tenho dia 20"); assert.equal(r.data, "2026-11-20"); assert.equal(it("agenda de quinta").data, "2026-11-19");
  assert.equal(it("agenda dentista dia 20 às 9h30").tipo, "rot_compromisso"); assert.equal(it("como está meu mês").tipo, "rot_mes"); assert.equal(it("como está meu mês").seguinte, false); assert.equal(it("planejamento do mês que vem").seguinte, true);
  assert.equal(it("como foi meu mês de gastos").tipo !== "rot_mes", true); assert.equal(it("resumo do mês").tipo, "fin_resumo"); assert.equal(it("como está meu ano").tipo, "rot_ano"); assert.equal(it("me mostra o ano que vem").seguinte, true);
  r = it("meta do mês: vender mais clareamentos"); assert.deepEqual([r.tipo, r.escopo, r.meta], ["rot_meta", "mes", "Vender mais clareamentos"]); r = it("adiciona meta do ano abrir segunda sala"); assert.deepEqual([r.escopo, r.meta], ["ano", "Abrir segunda sala"]);
  r = it("adiciona tarefa revisar contrato terça"); assert.deepEqual([r.tipo, r.tarefa, r.dia], ["rot_tarefa", "Revisar contrato", "2026-11-17"]);
});
