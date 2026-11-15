import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function ambiente() {
  const map = new Map();
  const localStorage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const ctx = vm.createContext({ localStorage, Date, setTimeout, clearTimeout, console }); ctx.window = ctx;
  for (const name of ['contacts', 'store', 'leads', 'fin', 'pessoal', 'backup']) vm.runInContext(readFileSync(new URL(`../web/${name}.js`, import.meta.url), 'utf8'), ctx);
  return ctx;
}

test('backup completo só depois que as coleções estão prontas; restauração conserva IDs existentes', async () => {
  const w = ambiente(), B = w.JarvisBackup, L = w.JarvisLeads, F = w.JarvisFin;
  assert.throws(() => B.gerar(), /Aguarde/);
  await Promise.all([L.iniciar(), F.iniciar()]);
  const lead = L.novo({ nome: 'Pessoa Teste', tel: '27 99999-9999', interesse: 'consulta' });
  const fin = F.novo({ tipo: 'despesa', descricao: 'Material', valor: 25 });
  const fixa = F.novaFixa({ descricao: 'Assinatura fictícia', valor: 15, dia: 5 });
  await L.salvar(lead); await F.salvar(fin); await F.salvar(fixa);
  const original = B.gerar();
  assert.equal(original.formato, 'jarvis-backup-v1');
  assert.equal(original.leads.length, 1); assert.equal(original.financeiro.length, 2);
  const p = w.JarvisPessoal.ler(); p.perfil.foco = 'Prioridade de teste'; p.perfil.compartilhar = true;
  p.tarefas.push({ id: 't1', dia: '2026-11-15', texto: 'Tarefa de teste', feita: false });
  assert.equal(w.JarvisPessoal.salvar(p), true);
  w.localStorage.setItem('jarvis_contatos_v1', JSON.stringify([{ nome: 'Contato Teste', tel: '+55 27 98888-8888' }]));
  original.pessoal = w.JarvisPessoal.ler();
  original.contatos = w.JarvisBackup.gerar().contatos;
  const w2 = ambiente(); await Promise.all([w2.JarvisLeads.iniciar(), w2.JarvisFin.iniciar()]);
  const r = await w2.JarvisBackup.restaurar(JSON.parse(JSON.stringify(original)));
  assert.equal(r.leads, 1); assert.equal(r.financeiro, 2); assert.equal(r.contatos, 1); assert.equal(r.falhas, 0);
  assert.equal(w2.JarvisFin.fixas().length, 1);
  assert.equal(w2.JarvisPessoal.ler().perfil.compartilhar, false);
  assert.equal(w2.JarvisPessoal.ler().tarefas.length, 1);
  const again = await w2.JarvisBackup.restaurar(JSON.parse(JSON.stringify(original)));
  assert.equal(again.leads, 0); assert.equal(again.financeiro, 0);
  assert.equal(w2.JarvisLeads.lista().length, 1);
  assert.equal(JSON.parse(w2.localStorage.getItem('jarvis_contatos_v1')).length, 1);
});

test('falha ao gravar localmente não exibe item que não foi salvo', async () => {
  const w = ambiente(); await w.JarvisLeads.iniciar();
  w.localStorage.setItem = () => { throw Error('sem espaço'); };
  const lead = w.JarvisLeads.novo({ nome: 'Pessoa Teste', tel: '27 99999-9999' });
  assert.equal(await w.JarvisLeads.salvar(lead), false);
  assert.equal(w.JarvisLeads.lista().length, 0);
});

test('arquivo inválido é recusado antes de qualquer gravação', async () => {
  const w = ambiente(); await Promise.all([w.JarvisLeads.iniciar(), w.JarvisFin.iniciar()]);
  const raw = w.JarvisBackup.gerar();
  raw.financeiro.push({ id: 'erro', tipo: 'despesa', valor: -10, data: '2026-11-15' });
  await assert.rejects(w.JarvisBackup.restaurar(raw), /lançamento/);
  assert.equal(w.JarvisLeads.lista().length, 0); assert.equal(w.JarvisFin.lista().length, 0);
});
