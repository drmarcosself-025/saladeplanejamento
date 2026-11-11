import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../web/pessoal.js', import.meta.url), 'utf8');
function setup(falhar = false) {
  const itens = new Map(), ctx = { window: { JarvisLeads: { iso: () => '2026-11-11' } }, localStorage: { getItem:k=>itens.get(k),setItem:(k,v)=>{if(falhar)throw Error('full');itens.set(k,v);} } };
  vm.createContext(ctx); vm.runInContext(source,ctx); return ctx.window.JarvisPessoal;
}
test('contexto pessoal só sai para o Claude quando compartilhado explicitamente', () => {
  const p=setup(),d=p.ler();d.perfil.foco='Minha prioridade privada';d.perfil.rotina='Minha rotina privada';
  d.tarefas.push({id:'1',dia:'2026-11-11',texto:'Minha tarefa privada',feita:false});assert.equal(p.salvar(d),true);
  assert.doesNotMatch(p.contexto(),/privada/);
  d.perfil.compartilhar=true;p.salvar(d);assert.match(p.contexto(),/Minha prioridade privada/);assert.match(p.contexto(),/Minha tarefa privada/);
});
test('falha ao salvar não altera o contexto em memória', () => {
  const p=setup(true),d=p.ler();d.perfil.nome='Outro nome';assert.equal(p.salvar(d),false);assert.equal(p.ler().perfil.nome,'Marcos');
});
test('dados corrompidos, limites e leitura sem mutação externa', () => {
  const p=setup(),r=p.validar({perfil:{nome:'x'.repeat(90)},tarefas:[null,{id:'a',dia:'invalid',texto:'inválida'}]});assert.equal(r.perfil.nome.length,40);assert.equal(r.tarefas.length,0);
  const copia=p.ler();copia.perfil.nome='Alterado';assert.equal(p.ler().perfil.nome,'Marcos');
});
