import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require(process.env.JARVIS_PLAYWRIGHT || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules') + '/playwright')); }
const binary = process.env.CHROMIUM_PATH || (!process.env.CI && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ headless: true, ...(binary ? { executablePath: binary } : {}), args: ['--no-sandbox'] });
const errors = [];
const output = process.env.JARVIS_SCREENSHOTS || '/tmp/jarvis-screenshots'; mkdirSync(output, { recursive: true });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(process.env.JARVIS_TEST_URL || 'http://localhost:8000');
    await page.locator('#boot').waitFor({ state: 'hidden' });
    await page.evaluate(() => { JarvisVoice.mudo = true; JarvisSfx.mudo = true; });
    const cmd = async (s) => {
      await page.locator('#entrada').fill(s); await page.locator('#barra button[type=submit]').click();
    };
    const fala = async (part) => {
      await page.waitForFunction(t => document.getElementById('legenda').textContent.includes(t), part);
    };
    const view = async (id) => { await page.locator(`.main-nav button[data-view="${id}"]`).click(); };
    assert.equal(await page.locator('body').getAttribute('data-vista'), 'hoje');
    await page.locator('#tarefaTexto').fill('Organizar minha manhã');
    await page.locator('#tarefaForm button').click();
    assert.match(await page.locator('#tarefasLista').innerText(), /Organizar minha manhã/);
    await page.screenshot({ path: `${output}/hoje-${width}.png`, fullPage: true });
    await view('pessoal');
    await page.locator('#perfilFoco').fill('Ter mais tempo para mim');
    await page.locator('#perfilRotina').fill('Consultório às quartas');
    await page.locator('#perfilForm button[type=submit]').click();
    assert.match(await page.locator('#perfilStatus').innerText(), /salvo/);
    const noShare = await page.evaluate(() => JarvisPessoal.contexto());
    assert.doesNotMatch(noShare, /Ter mais tempo/);
    await view('hoje'); assert.match(await page.locator('#focoTexto').innerText(), /Ter mais tempo/);
    await view('espacos');
    assert.equal(await page.locator('#chips button').count(), 7);
    await page.screenshot({ path: `${output}/espacos-${width}.png`, fullPage: true });
    await page.locator('[data-open="painelContatos"]').click();
    assert.equal(await page.locator('#painelContatos').isVisible(), true);
    await view('hoje');
    await cmd('novo lead, João Silva, 27 99999-1234, veio do Instagram, quer alinhadores');
    await fala('Anotei João Silva');
    await cmd('abre o CRM');
    await page.locator('#crmTela').waitFor({ state: 'visible' });
    assert.match(await page.locator('#crmQuadro').innerText(), /João Silva/);
    await page.locator('#crmQuadro .crm-cartao').first().click();
    await page.locator('#crmDetalhe input[aria-label="Valor estimado"]').fill('3200');
    await page.locator('#crmDetalhe textarea').fill('Aguardando documentação');
    await page.getByRole('button', { name: 'Salvar valor e nota' }).click();
    await page.waitForFunction(() => document.getElementById('crmDetalhe').textContent.includes('Aguardando documentação'));
    await page.locator('#crmDetalhe select').selectOption('sem_interesse');
    await page.waitForFunction(() => document.getElementById('crmQuadro').textContent.includes('Sem interesse · 1'));
    await page.screenshot({ path: `${output}/crm-${width}.png`, fullPage: true });
    await page.locator('#crmFechar').click();
    await cmd('conta de energia'); await fala('Qual o valor');
    await cmd('189,90');
    await page.locator('#finTela').waitFor({ state: 'visible' });
    assert.match(await page.locator('#finLista').innerText(), /189,90/);
    await page.locator('#finDescricao').fill('Consulta particular');
    await page.locator('#finValor').fill('350');
    await page.locator('#finTipo').selectOption('receita');
    await page.locator('#finForm button[type=submit]').click();
    await page.waitForFunction(() => document.getElementById('finMetricas').textContent.includes('350,00'));
    await page.screenshot({ path: `${output}/contador-${width}.png`, fullPage: true });
    await page.locator('#finFechar').click();
    await cmd('ativa o agente designer'); await fala('Modo Designer');
    await cmd('crie uma legenda sobre alinhadores'); await fala('Claude não está disponível');
    await page.evaluate(() => {
      JarvisBrain.perguntarClaude = async a => { window.ultimoContexto = a.contexto; return { fala: 'Mostrei na tela.', titulo: 'Rascunho', itens: ['Legenda completa para copiar.'], acoes: ['abre o CRM'] }; };
    });
    await cmd('crie outra legenda'); await fala('Mostrei na tela');
    await page.locator('#respostaCard').waitFor({ state: 'visible' });
    assert.match(await page.locator('#respostaCard').innerText(), /Legenda completa para copiar/);
    assert.doesNotMatch(await page.evaluate(() => window.ultimoContexto), /Ter mais tempo/);
    await page.screenshot({ path: `${output}/conversa-${width}.png`, fullPage: true });
    await view('pessoal'); await page.locator('#perfilCompartilhar').check(); await page.locator('#perfilForm button[type=submit]').click();
    await cmd('como organizar meu dia'); await fala('Mostrei na tela');
    assert.match(await page.evaluate(() => window.ultimoContexto), /Ter mais tempo/);
    await view('hoje');
    assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth + 2), true, `overflow ${width}`);
    const composer = await page.locator('#barra').boundingBox();
    if (width === 390) {
      const nav = await page.locator('.main-nav').boundingBox();
      assert.ok(composer.y + composer.height <= nav.y, 'compositor não cobre navegação');
    }
    await page.reload(); await page.locator('#boot').waitFor({ state: 'hidden' });
    assert.match(await page.locator('#tarefasLista').innerText(), /Organizar minha manhã/);
    assert.match(await page.locator('#focoTexto').innerText(), /Ter mais tempo/);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Browser OK: navegação, privacidade de contexto, tarefas, CRM, finanças, ausência de sample, resposta estruturada, persistência e 390px.');
} finally { await browser.close(); }
