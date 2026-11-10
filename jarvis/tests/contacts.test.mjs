// node --test jarvis/tests/contacts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const win = {};
vm.runInContext(fs.readFileSync(path.join(dir, "contacts.js"), "utf8"), vm.createContext({ window: win, TextDecoder }));
const C = win.JarvisContatos;
const arr = (x) => JSON.parse(JSON.stringify(x));   // atravessa o contexto do vm

test("telefone: DDD, +55, formatado, internacional", () => {
  assert.equal(C.normalizarTel("(63) 99999-0000").tel, "5563999990000");
  assert.equal(C.normalizarTel("+55 63 99999-0000").tel, "5563999990000");
  assert.equal(C.normalizarTel("063 99999-0000").tel, "5563999990000");
  assert.equal(C.normalizarTel("+1 415 555 0100").tel, "14155550100");
  assert.equal(C.formatarTel("5563999990000"), "+55 63 99999-0000");
});
test("telefone: fixo e inválido são recusados com motivo", () => {
  assert.deepEqual(arr(C.normalizarTel("(63) 3215-1234")), { tel: null, motivo: "fixo" });
  assert.equal(C.normalizarTel("99999-0000").tel, null);   // sem DDD
  assert.equal(C.normalizarTel("abc").tel, null);
});
test("vCard: Google/Android, N sem FN, várias linhas TEL, acento em quoted-printable", () => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Maria Souza", "TEL;TYPE=CELL:+55 63 98888-7777", "TEL;TYPE=HOME:(63) 3215-1234", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "N:Pereira;João;;;", "item1.TEL;type=pref:63 97777-6666", "END:VCARD",
    "BEGIN:VCARD", "VERSION:2.1", "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 =C3=82ngelo", "TEL;CELL:63 96666-5555", "END:VCARD",
    "BEGIN:VCARD", "FN:Sem Telefone", "END:VCARD",
    "BEGIN:VCARD", "FN:Só Fixo", "TEL:(63) 3215-0000", "END:VCARD",
    "BEGIN:VCARD", "FN:Maria Repetida", "TEL:63988887777", "END:VCARD",
  ].join("\r\n");
  const r = C.importar(vcf, "contatos.vcf");
  assert.deepEqual(arr(r.contatos.map((c) => c.nome)), ["Maria Souza", "João Pereira", "José Ângelo"]);
  assert.equal(r.contatos[0].tel, "+55 63 98888-7777");
  assert.equal(r.lidos, 6); assert.equal(r.semTelefone, 1); assert.equal(r.fixos, 1); assert.equal(r.repetidosNoArquivo, 1);
});
test("CSV do Google Contatos (colunas First/Last Name, Phone 1 - Value, vários números)", () => {
  const csv = 'First Name,Last Name,Phone 1 - Label,Phone 1 - Value,Phone 2 - Value\n' +
    'Ana,"Lima, Jr",Mobile,+55 63 91111-2222,\n' +
    'Bruno,Dias,Home,(63) 3215-9999,63 92222-3333\n' +
    'Carla,Melo,Mobile,63 93333-4444 ::: 63 94444-5555,\n';
  const r = C.importar(csv, "contacts.csv");
  assert.deepEqual(arr(r.contatos.map((c) => [c.nome, c.tel])), [
    ["Ana Lima, Jr", "+55 63 91111-2222"], ["Bruno Dias", "+55 63 92222-3333"], ["Carla Melo", "+55 63 93333-4444"]]);
});
test("CSV de planilha com ponto e vírgula e cabeçalho em português (Clinicorp, etc.)", () => {
  const csv = "Nome;Celular;Data de nascimento\nPaciente Um;(63) 99999-1111;01/01/1990\nPaciente Dois;63 98888-2222;02/02/1985\n";
  const r = C.importar(csv, "pacientes.csv");
  assert.equal(r.contatos.length, 2); assert.equal(r.contatos[1].nome, "Paciente Dois");
});
test("CSV sem cabeçalho: nome,telefone", () => {
  const r = C.importar("João,63 99999-0000\nMaria,63 98888-0000\n", "x.csv");
  assert.equal(r.contatos.length, 2);
});
test("mesclar não duplica telefone e o que já existe vence", () => {
  const ex = [{ nome: "Maria (antiga)", tel: "63 98888-7777" }];
  const m = C.mesclar(ex, [{ nome: "Maria Souza", tel: "+55 63 98888-7777" }, { nome: "Novo", tel: "+55 63 97777-1111" }]);
  assert.equal(m.adicionados, 1); assert.equal(m.repetidos, 1);
  assert.equal(m.lista[0].nome, "Maria (antiga)");
});
test("arquivo grande: 5000 contatos importam rápido", () => {
  let v = ""; for (let i = 0; i < 5000; i++) v += `BEGIN:VCARD\nFN:Contato ${i}\nTEL:+55 63 9${String(10000000 + i)}\nEND:VCARD\n`;
  const t0 = Date.now(), r = C.importar(v, "g.vcf");
  assert.equal(r.contatos.length, 5000); assert.ok(Date.now() - t0 < 1500);
});
