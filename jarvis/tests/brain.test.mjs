// Testa o interpretador de comandos (sem navegador): node --test jarvis/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const win = {};
const ctx = vm.createContext({ window: win, fetch: async () => ({ ok: false }) });
for (const f of ["modes.js", "brain.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
const { interpretar } = win.JarvisBrain;
const M = win.JARVIS_MODES;
const it = (t) => interpretar(t, M);

test("ativar por frase natural", () => {
  assert.deepEqual([it("Jarvis, ativa agora o agente social media").tipo, it("Jarvis, ativa agora o agente social media").modo], ["ativar", "social"]);
  assert.equal(it("ativa o agente gestor de tráfego").modo, "trafego");
  assert.equal(it("Jarvis, abre o modo programador").modo, "programador");
  assert.equal(it("ativa gestão do dia").modo, "gestao");
});
test("apelido mais longo vence (social media x social)", () => {
  assert.equal(it("ativa social media").modo, "social");
});
test("sair do modo", () => {
  for (const t of ["Jarvis, desativa o agente gestor de tráfego", "volta ao normal", "desativa o agente social media"])
    assert.equal(it(t).tipo, "sair", t);
});
test("confirmar e cancelar só valem como frase curta", () => {
  assert.equal(it("Jarvis, confirma").tipo, "confirmar");
  assert.equal(it("cancela").tipo, "cancelar");
  assert.equal(it("não confirma essa consulta amanhã").tipo, "pergunta"); // frase longa NÃO confirma nada
});
test("pergunta comum não ativa modo sem verbo", () => {
  assert.equal(it("como está o tráfego hoje").tipo, "pergunta");
});
test("vazio", () => assert.equal(it("  jarvis  ").tipo, "vazio"));

// ---------- mensagens de WhatsApp ----------
const { acharContato, linkWhatsapp } = win.JarvisBrain;

test("mensagem: contato + texto, preservando acento e maiúscula", () => {
  const r = it("Jarvis, manda mensagem pro João Silva dizendo que a consulta é amanhã às 9h");
  assert.equal(r.tipo, "mensagem");
  assert.equal(r.nome, "João Silva");
  assert.equal(r.mensagem, "A consulta é amanhã às 9h");
});
test("mensagem: 'entra no meu WhatsApp e entra em contato com o fulano de tal'", () => {
  const r = it("Jarvis, entra no meu WhatsApp e entra em contato com o fulano de tal");
  assert.equal(r.tipo, "mensagem");
  assert.equal(r.nome, "fulano de tal");
  assert.equal(r.mensagem, null); // falta o texto: o app pergunta
});
test("mensagem: variações de verbo", () => {
  assert.equal(it("avisa a Maria falando que o orçamento ficou pronto").nome, "Maria");
  assert.equal(it("envia uma mensagem para o Dr. Pedro e diz que chego atrasado").mensagem, "Chego atrasado");
});
test("mensagem não atrapalha troca de modo nem pergunta", () => {
  assert.equal(it("ativa o agente social media").tipo, "ativar");
  assert.equal(it("como está o tráfego hoje").tipo, "pergunta");
});
test("acharContato: sem acento, parcial, ambíguo e inexistente", () => {
  const c = [{ nome: "João Silva", tel: "" }, { nome: "João Pereira", tel: "" }, { nome: "Maria Souza", tel: "" }];
  assert.equal(acharContato("joao silva", c).length, 1);
  assert.equal(acharContato("João", c).length, 2);      // ambíguo
  assert.equal(acharContato("maria", c)[0].nome, "Maria Souza");
  assert.equal(acharContato("fulano", c).length, 0);
  assert.equal(acharContato("o", c).length, 0);         // só palavra vazia não casa tudo
});
test("linkWhatsapp: DDD vira +55, texto é codificado, número ruim é recusado", () => {
  assert.equal(linkWhatsapp("(63) 99999-0000", "Olá, tudo bem?"), "https://wa.me/5563999990000?text=Ol%C3%A1%2C%20tudo%20bem%3F");
  assert.equal(linkWhatsapp("+55 63 99999-0000", ""), "https://wa.me/5563999990000");
  assert.equal(linkWhatsapp("12345", "x"), null);
});
