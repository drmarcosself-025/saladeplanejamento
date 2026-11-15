import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { window: { APP_CONFIG: {}, JarvisPessoal: { ler: () => ({ perfil: { nome: 'Marcos' }, tarefas: [] }) }, JarvisLeads: { iso: () => '2026-11-11', resumo: () => ({ hoje: 1, semData: 0, atrasados: 0, ativos: 2 }), lista: () => [] }, JarvisFin: {
  lista: () => [{ id: 'x', descricao: 'Energia', valor: 189.9, vencimento: '2026-11-13' }],
  pendentes: (ls) => ls, mesDe: () => '2026-11',
  resumoMes: () => ({ receitas: 350, despesas: 0, saldo: 350, aPagar: 189.9, aReceber: 0 }),
} } };
vm.createContext(ctx);
for (const file of ['modes.js', 'rotina.js', 'data.js']) vm.runInContext(fs.readFileSync(new URL('../web/' + file, import.meta.url), 'utf8'), ctx);

test('sete modos novos têm instruções e não prometem integração inexistente', () => {
  const ids = [...ctx.window.JARVIS_ORDEM];
  assert.deepEqual(ids, ['gestao','leads','trafego','social','designer','programador','contador']);
  assert.equal(ctx.window.JARVIS_MODES.gestao.nome, 'Dia a Dia');
  assert.match(ctx.window.JARVIS_MODES.designer.instrucao, /promessa de resultado/);
  assert.match(ctx.window.JARVIS_MODES.programador.instrucao, /Não alegue acesso ao computador/);
  assert.ok(ids.every(id => ctx.window.JARVIS_MODES[id].instrucao));
});

test('Dia a Dia usa dados reais (sem pacientes de demonstração); Contador usa lançamentos do usuário', async () => {
  const dia = await ctx.window.JarvisData.get('gestao');
  assert.equal(dia.source, 'seus');
  assert.equal(dia.contas[0].descricao, 'Energia');
  assert.equal(dia.retornos, 1);
  assert.equal(dia.pacientes, undefined);
  assert.match(ctx.window.JARVIS_MODES.gestao.abertura(dia), /Modo Dia a Dia ativado\./);
  assert.ok(!/demonstração/i.test(ctx.window.JARVIS_MODES.gestao.abertura(dia)));
  const fin = await ctx.window.JarvisData.get('contador');
  assert.equal(fin.source, 'seus');
  assert.equal(fin.saldo_fmt, 'R$ 350,00');
});
