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
