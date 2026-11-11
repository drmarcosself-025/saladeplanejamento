import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require((process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules') + '/playwright');
const binary = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ headless: true, ...(binary ? { executablePath: binary } : {}), args: ['--no-sandbox'] });
const errors = [];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:8000');
    await page.locator('#boot').waitFor({ state: 'hidden' });
    const cmd = async (s) => { await page.locator('#entrada').fill(s); await page.locator('#barra button[type=submit]').click(); };
    await cmd('novo lead, João Silva, 27 99999-1234, veio do Instagram, quer alinhadores');
    await page.getByText('Anotei João Silva').waitFor();
    await cmd('abre o CRM');
    await page.locator('#crmTela').waitFor({ state: 'visible' });
    assert.match(await page.locator('#crmQuadro').innerText(), /João Silva/);
    await page.locator('#crmQuadro .crm-cartao').first().click();
    await page.locator('#crmDetalhe input[aria-label="Valor estimado"]').fill('3200');
    await page.locator('#crmDetalhe textarea').fill('Aguardando documentação');
    await page.getByRole('button', { name: 'Salvar valor e nota' }).click();
    assert.match(await page.locator('#crmDetalhe').innerText(), /Aguardando documentação/);
    await page.locator('#crmDetalhe select').selectOption('sem_interesse');
    assert.match(await page.locator('#crmQuadro').innerText(), /Sem interesse · 1/);
    await page.locator('#crmFechar').click();
    await cmd('conta de energia');
    assert.match(await page.locator('#legenda').innerText(), /Qual o valor/);
    await cmd('189,90');
    await page.locator('#finTela').waitFor({ state: 'visible' });
    assert.match(await page.locator('#finLista').innerText(), /189,90/);
    await page.locator('#finDescricao').fill('Consulta particular');
    await page.locator('#finValor').fill('350');
    await page.locator('#finTipo').selectOption('receita');
    await page.locator('#finForm button[type=submit]').click();
    assert.match(await page.locator('#finMetricas').innerText(), /350,00/);
    await page.locator('#finFechar').click();
    await cmd('ativa o agente designer');
    await cmd('crie uma legenda sobre alinhadores');
    assert.match(await page.locator('#legenda').innerText(), /Claude não está disponível/);
    await page.evaluate(() => {
      const b = window.JarvisBrain;
      // A resposta estruturada é verificada pelo DOM mediante uma amostra simulada.
      b.perguntarClaude = async () => ({ fala: 'Mostrei na tela.', titulo: 'Rascunho', itens: ['Legenda completa para copiar.'], acoes: [] });
    });
    await cmd('crie outra legenda');
    await page.locator('#respostaCard').waitFor({ state: 'visible' });
    assert.match(await page.locator('#respostaCard').innerText(), /Legenda completa para copiar/);
    assert.equal(await page.locator('#legenda').innerText(), 'Mostrei na tela.');
    assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth + 2), true, `overflow ${width}`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Browser: CRM, financeiro por voz/formulário, resposta estruturada, ausência de sample e 390px OK');
} finally { await browser.close(); }
