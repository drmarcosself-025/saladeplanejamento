// node --test jarvis/tests/social.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const win = {};
const ctx = vm.createContext({ window: win, TextDecoder, localStorage: undefined });
for (const f of ["modes.js", "contacts.js", "store.js", "leads.js", "fin.js", "rotina.js", "social.js", "avisos.js", "brain.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
const S = win.JarvisSocial, A = win.JarvisAvisos, B = win.JarvisBrain, M = win.JARVIS_MODES, C = win.JarvisContatos;
const j = (x) => JSON.parse(JSON.stringify(x));
const SEX = new Date(2026, 10, 13, 10, 0);
const it = (t) => j(B.interpretar(t, M, SEX));

test("comentários: pendentes, achar por autor, respostas locais sem preço nem promessa", () => {
  const a = S.novoComentario({ autor: "@maria.silva", texto: "Quanto custa o clareamento?" }), b = S.novoComentario({ autor: "João", texto: "Amei o resultado!" });
  assert.equal(a.autor, "maria.silva"); assert.equal(S.novoComentario({ texto: " " }).erro, "texto");
  const d = j(S.validar({ comentarios: [a, { ...b, status: "respondido" }] }));
  assert.equal(S.pendentes(d).length, 1); assert.equal(S.achar(d, "maria").length, 1); assert.equal(S.achar(d, "joão").length, 0);
  const r = S.respostasLocais(a); assert.equal(r.length, 3); assert.ok(r.every((x) => !/R\$|\d+%|garant|promoç/i.test(x))); assert.match(r[0], /direct/);
  assert.match(S.respostasLocais(b)[0], /Obrigada, João/);
});
test("posts: calendário, atrasados e resumo", () => {
  const p1 = S.novoPost({ tema: "Clareamento", data: "2026-11-13", formato: "Reels" }, "2026-11-13"), p2 = { ...S.novoPost({ tema: "Implante", data: "2026-11-10" }, "2026-11-13") }, p3 = { ...S.novoPost({ tema: "Ok", data: "2026-11-14" }, "2026-11-13"), status: "postado" };
  assert.equal(S.novoPost({ tema: "" }, "x").erro, "tema"); assert.equal(p1.formato, "Reels"); assert.equal(p2.formato, "Foto");
  const d = j(S.validar({ posts: [p1, p2, p3] }));
  assert.equal(S.postsDoDia(d, "2026-11-13").length, 1); assert.equal(S.atrasados(d, "2026-11-13").length, 1);
  assert.deepEqual(j(S.resumo(d, "2026-11-13", "2026-11-15")), { pendentes: 0, hoje: 1, atrasados: 1, semana: 1, postados: 1 });
});
test("métricas do Meta: CSV com vírgula decimal, datas BR/ISO, ranking", () => {
  const csv = "Descrição;Data de publicação;Alcance;Curtidas;Comentários;Compartilhamentos;Salvamentos\nReels clareamento;10/11/2026;1.200;80;10;5;20\nFoto equipe;2026-11-05;300;40;1;0;0\n";
  const r = j(S.lerMetricas(C._lerCsvLinhas(csv)));
  assert.equal(r.posts.length, 2); assert.deepEqual([r.posts[0].alcance, r.posts[0].data, r.posts[1].data], [1200, "2026-11-10", "2026-11-05"]);
  assert.equal(S.melhores(r.posts, 1)[0].titulo, "Reels clareamento"); assert.match(S.lerMetricas(C._lerCsvLinhas("a;b\n1;2")).erro, /Não achei colunas/); assert.match(S.lerMetricas([]).erro, /vazio/);
});
test("central de avisos: ordem por importância, fala curta e tudo em dia", () => {
  const base = { hoje: "2026-11-13", hora: 15, leadsAtrasados: 0, retornosHoje: 0, contasAtrasadas: 0, contasVencendo: [], compromissos: [], comentarios: 0, postsHoje: 0, postsAtrasados: 0, tarefas: 0, agua: 4, meta: 8, clientesParados: 0 };
  assert.equal(A.montar(base).fala, "Está tudo em dia. Nenhuma pendência agora."); assert.equal(A.montar({ ...base, agua: 8 }).total, 0);
  const r = A.montar({ ...base, agua: 2, leadsAtrasados: 2, comentarios: 3, contasVencendo: [{ descricao: "Energia", vencimento: "2026-11-15" }], compromissos: [{ titulo: "Dentista", hora: "16:00", feito: false }], clientesParados: 4, tarefas: 1 });
  assert.deepEqual(j(r.itens.map((x) => x.nivel)), ["alta", "media", "media", "media", "info", "info", "info"]); assert.equal(r.itens[0].cmd, "quem preciso retornar hoje");
  assert.match(r.fala, /^Você tem 7 avisos, 4 importantes\. 2 retornos de leads atrasados\./); assert.match(r.itens.map((x) => x.texto).join("|"), /3 comentários esperando resposta/);
  assert.equal(A.montar({ ...base, compromissos: [{ titulo: "Passou", hora: "08:00", feito: false }], agua: 8 }).total, 0);   // compromisso já passou
});
test("voz: avisos, CRC, comentários e posts", () => {
  for (const f of ["quais minhas notificações", "quais são as pendências", "o que tem de novo", "me atualiza", "o que preciso fazer agora", "tenho algum aviso"]) assert.equal(it(f).tipo, "avisos_ver", f);
  assert.equal(it("quais contas pendentes").tipo, "fin_pendentes");
  for (const f of ["quais clientes preciso reativar", "clientes sem contato", "mostra o crc"]) assert.equal(it(f).tipo, "avisos_crc", f);
  let r = it("anota comentário de @maria: quanto custa o clareamento"); assert.deepEqual([r.tipo, r.autor, r.comentario], ["soc_comentario", "@maria", "quanto custa o clareamento"]);
  r = it("novo comentário da Maria Silva: amei o resultado"); assert.deepEqual([r.tipo, r.autor, r.comentario], ["soc_comentario", "Maria Silva", "amei o resultado"]);
  assert.equal(it("quais comentários preciso responder").tipo, "soc_comentarios");
  r = it("sugere resposta para a Maria"); assert.deepEqual([r.tipo, r.autor], ["soc_responder", "Maria"]); assert.equal(it("responde o comentário da Ana").tipo, "soc_responder");
  r = it("respondi a Maria"); assert.deepEqual([r.tipo, r.autor], ["soc_respondido", "Maria"]);
  r = it("agenda um reels sobre clareamento sexta"); assert.deepEqual([r.tipo, r.tema, r.formato, r.data], ["soc_post", "Clareamento", "Reels", "2026-11-20"]);
  r = it("planeja post de implante dia 18"); assert.deepEqual([r.tema, r.data, r.formato], ["Implante", "2026-11-18", "Foto"]);
  assert.equal(it("quais posts tenho para hoje").tipo, "soc_posts"); assert.equal(it("calendário de posts").tipo, "soc_posts");
  assert.equal(it("como está meu instagram").tipo, "soc_instagram"); assert.equal(it("abre o instagram").tipo, "soc_abrir");
  assert.equal(it("marca reunião amanhã às 14h").tipo, "rot_compromisso"); assert.equal(it("bom dia").tipo, "rot_dia"); assert.equal(it("ativa o agente social media").tipo, "ativar");
});
