// node --test jarvis/tests/leads.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const win = {};
const ctx = vm.createContext({ window: win, TextDecoder, localStorage: undefined });
for (const f of ["modes.js", "contacts.js", "leads.js", "brain.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
const L = win.JarvisLeads, B = win.JarvisBrain, M = win.JARVIS_MODES;
const j = (x) => JSON.parse(JSON.stringify(x));
const QUA = new Date(2026, 10, 11, 10, 0);      // quarta, 11/11/2026
const it = (t) => j(B.interpretar(t, M, QUA));

// ---------- datas ----------
test("dataDe: amanhã, depois de amanhã, dias, semana, dia da semana, dd/mm, dia N", () => {
  assert.equal(L.dataDe("amanhã", QUA), "2026-11-12");
  assert.equal(L.dataDe("depois de amanhã", QUA), "2026-11-13");
  assert.equal(L.dataDe("daqui a 3 dias", QUA), "2026-11-14");
  assert.equal(L.dataDe("semana que vem", QUA), "2026-11-18");
  assert.equal(L.dataDe("sexta", QUA), "2026-11-13");
  assert.equal(L.dataDe("quarta", QUA), "2026-11-18");      // mesmo dia da semana = a próxima
  assert.equal(L.dataDe("15/12", QUA), "2026-12-15");
  assert.equal(L.dataDe("05/11", QUA), "2027-11-05");        // já passou: ano que vem
  assert.equal(L.dataDe("dia 20", QUA), "2026-11-20");
  assert.equal(L.dataDe("dia 5", QUA), "2026-12-05");        // já passou: mês que vem
  assert.equal(L.dataDe("31/02", QUA), null);
  assert.equal(L.dataDe("sei lá", QUA), null);
});
test("rótulos: hoje, amanhã, atrasado, em N dias, data", () => {
  const h = "2026-11-11";
  assert.deepEqual(["2026-11-11", "2026-11-12", "2026-11-09", "2026-11-10", "2026-11-14", "2026-11-25", ""].map((d) => L.rotulo(d, h)),
    ["Hoje", "Amanhã", "Atrasado 2 dias", "Atrasado 1 dia", "Em 3 dias", "25/11", "Sem data"]);
});
test("virada de mês e de ano", () => {
  assert.equal(L.somar("2026-12-31", 1), "2027-01-01");
  assert.equal(L.somar("2026-11-30", 2), "2026-12-02");
});

// ---------- regra central: ativo sempre tem data ----------
test("novo lead nasce 'novo' com retorno hoje; telefone ruim é recusado", () => {
  const l = j(L.novo({ nome: "  joão   silva ", tel: "63 98888-7777", origem: "instagram", interesse: "clareamento" }, QUA));
  assert.equal(l.id, "5563988887777"); assert.equal(l.nome, "joão silva"); assert.equal(l.origem, "Instagram");
  assert.equal(l.etapa, "novo"); assert.equal(l.proximo, "2026-11-11"); assert.equal(l.tel, "+55 63 98888-7777");
  assert.equal(L.novo({ nome: "x", tel: "(63) 3215-1234" }, QUA).erro, "fixo");
  assert.equal(L.novo({ nome: "x", tel: "123" }, QUA).erro, "telefone");
});
test("fechou/perdido não cobram; reativar devolve data; ativo sem data ganha hoje", () => {
  const l = L.novo({ nome: "Ana", tel: "63 97777-1111" }, QUA);
  const f = j(L.comEtapa(l, "fechou", QUA)); assert.equal(f.proximo, "");
  const r = j(L.comEtapa(f, "conversando", QUA)); assert.equal(r.proximo, "2026-11-11");
  assert.equal(L.garantirRegra({ etapa: "orcamento", proximo: "" }, QUA).proximo, "2026-11-11");
});
test("depois do contato: registra, novo→conversando e próximo em +2 dias", () => {
  const l = L.novo({ nome: "Ana", tel: "63 97777-1111" }, QUA);
  const a = j(L.aposContato(l, QUA));
  assert.equal(a.ultimoContato, "2026-11-11"); assert.equal(a.etapa, "conversando"); assert.equal(a.proximo, "2026-11-13");
  assert.equal(j(L.aposContato({ ...l, etapa: "orcamento" }, QUA)).etapa, "orcamento");   // outras etapas não mudam
});
test("filtros e resumo: atrasados, hoje, devidos, encerrados fora", () => {
  const mk = (n, tel, etapa, proximo) => ({ ...L.novo({ nome: n, tel }, QUA), etapa, proximo });
  const ls = [mk("A", "63 91111-0001", "novo", "2026-11-09"), mk("B", "63 91111-0002", "conversando", "2026-11-11"),
              mk("C", "63 91111-0003", "orcamento", "2026-11-15"), mk("D", "63 91111-0004", "fechou", ""), mk("E", "63 91111-0005", "perdido", "")];
  assert.deepEqual(j(L.filtrar(ls, "atrasados", QUA)).map((l) => l.nome), ["A"]);
  assert.deepEqual(j(L.filtrar(ls, "hoje", QUA)).map((l) => l.nome), ["B"]);
  assert.deepEqual(j(L.filtrar(ls, "devidos", QUA)).map((l) => l.nome), ["A", "B"]);
  assert.deepEqual(j(L.filtrar(ls, "todos", QUA)).map((l) => l.nome), ["A", "B", "C"]);
  const r = j(L.resumo(ls, QUA));
  assert.deepEqual([r.total, r.ativos, r.hoje, r.atrasados, r.fechados, r.perdidos], [5, 3, 1, 1, 1, 1]);
});
test("mensagem de retorno por etapa, sem prometer preço", () => {
  const base = L.novo({ nome: "Maria Souza", tel: "63 98888-7777", interesse: "Lentes" }, QUA);
  assert.match(L.mensagemRetorno(base), /Olá, Maria!.*interesse em lentes/);
  assert.match(L.mensagemRetorno({ ...base, etapa: "orcamento" }), /avaliar o orçamento sobre lentes/);
  assert.match(L.mensagemRetorno({ ...base, etapa: "agendou" }), /confirmar a sua consulta/);
  assert.doesNotMatch(L.mensagemRetorno(base), /R\$|desconto|promo/i);
});
test("CSV: cabeçalho, aspas escapadas, BOM, ordenado por retorno", () => {
  const a = { ...L.novo({ nome: 'Ana "Lu"', tel: "63 97777-1111", interesse: "lentes; facetas" }, QUA), proximo: "2026-11-12" };
  const b = { ...L.novo({ nome: "Bia", tel: "63 97777-2222" }, QUA), proximo: "2026-11-10" };
  const c = L.csv([a, b]);
  assert.ok(c.startsWith("﻿\"Nome\";\"Telefone\""));
  const linhas = c.trim().split("\r\n"); assert.equal(linhas.length, 3);
  assert.match(linhas[1], /^"Bia"/); assert.match(linhas[2], /"Ana ""Lu"""/);
});

// ---------- comandos por voz ----------
test("novo lead: nome, telefone, origem e interesse (com e sem vírgulas)", () => {
  let r = it("Jarvis, novo lead: João Silva, 63 98888-7777, veio do Instagram, quer clareamento");
  assert.deepEqual([r.tipo, r.nome, r.tel, r.origem, r.interesse], ["lead_novo", "João Silva", "63 98888-7777", "Instagram", "clareamento"]);
  r = it("novo lead Maria 63988887777 veio do google quer lentes");
  assert.deepEqual([r.nome, r.tel, r.origem, r.interesse], ["Maria", "63988887777", "google", "lentes"]);
  r = it("cadastra lead Pedro Alves");
  assert.deepEqual([r.tipo, r.nome, r.tel], ["lead_novo", "Pedro Alves", null]);
});
test("consultas de retorno", () => {
  for (const t of ["Jarvis, quem eu preciso retornar hoje?", "quais leads tenho para retornar", "retornos de hoje"]) assert.equal(it(t).tipo, "lead_lista", t);
  assert.equal(it("meus leads").filtro, "todos"); assert.equal(it("quem está atrasado nos retornos").filtro, "atrasados");
});
test("retornar, adiar e mudar etapa", () => {
  assert.deepEqual([it("retorna pro João").tipo, it("retorna pro João").nome], ["lead_retorno", "joao"]);
  let r = it("retorna pro João amanhã"); assert.deepEqual([r.tipo, r.nome, r.quando], ["lead_adiar", "joao", "2026-11-12"]);
  r = it("adia o João para sexta"); assert.deepEqual([r.tipo, r.quando], ["lead_adiar", "2026-11-13"]);
  r = it("adia a Maria"); assert.deepEqual([r.tipo, r.nome, r.quando], ["lead_adiar", "maria", null]);   // app pergunta a data
  r = it("cobra a Maria daqui a 3 dias"); assert.equal(r.quando, "2026-11-14");
  r = it("marca o João como agendou"); assert.deepEqual([r.tipo, r.etapa], ["lead_etapa", "agendou"]);
  r = it("marca a Maria como orçamento enviado"); assert.equal(r.etapa, "orcamento");
  r = it("o João fechou"); assert.deepEqual([r.tipo, r.etapa, r.solto], ["lead_etapa", "fechou", true]);
  assert.equal(it("a Maria desistiu").etapa, "perdido");
});
test("não rouba comandos já existentes", () => {
  assert.equal(it("retorna ao normal").tipo, "sair"); assert.equal(it("volta ao normal").tipo, "sair");
  assert.equal(it("ativa o agente social media").tipo, "ativar");
  assert.equal(it("manda mensagem pro João dizendo oi").tipo, "mensagem");
  assert.equal(it("como está o tráfego hoje").tipo, "pergunta");
  assert.equal(it("E-mails para responder").tipo, "pergunta");
  assert.equal(it("Quais contas vencem esta semana?").tipo, "pergunta");
  assert.equal(it("Confirmar pacientes de amanhã").tipo, "pergunta");
});
test("modo Leads existe, é ativo e substituiu o WhatsApp planejado", () => {
  assert.equal(M.leads.status, "ativo"); assert.equal(M.whatsapp, undefined);
  assert.equal(it("ativa o modo leads").modo, "leads"); assert.equal(it("liga o agente de leads").modo, "leads");
  assert.equal(it("abre o funil").tipo, "lead_lista");   // pedir para ver o funil mostra a lista
  assert.match(M.leads.abertura({ total: 0 }), /ainda não tem leads/);
  assert.match(M.leads.abertura({ total: 5, ativos: 4, hoje: 2, atrasados: 1, semData: 0 }), /3 leads para retornar, 1 já atrasado/);
});
