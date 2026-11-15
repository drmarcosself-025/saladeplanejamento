import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require(process.env.JARVIS_PLAYWRIGHT || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules') + '/playwright')); }
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(process.env.JARVIS_TEST_URL || 'http://localhost:8000');
    await page.locator('#boot').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => JarvisBackup.pronto());
    await page.evaluate(async () => {
      await JarvisFin.salvar(JarvisFin.novo({ tipo: 'despesa', descricao: 'Item fictício', valor: 25 }));
      const p = JarvisPessoal.ler(); p.perfil.foco = 'Teste de cópia'; p.perfil.compartilhar = true;
      p.tarefas.push({ id: 'teste1', dia: JarvisLeads.iso(new Date()), texto: 'Tarefa fictícia', feita: false });
      JarvisPessoal.salvar(p);
    });
    const raw = await page.evaluate(() => JarvisBackup.gerar());
    await page.locator('.main-nav [data-view="pessoal"]').click();
    const downloaded = page.waitForEvent('download');
    await page.locator('#backupBaixar').click();
    assert.match((await downloaded).suggestedFilename(), /^jarvis-backup-.*\.json$/);

    const second = await browser.newContext({ viewport: { width, height: 850 } });
    const restored = await second.newPage();
    await restored.goto(process.env.JARVIS_TEST_URL || 'http://localhost:8000');
    await restored.locator('#boot').waitFor({ state: 'hidden' });
    await restored.waitForFunction(() => JarvisBackup.pronto());
    await restored.locator('.main-nav [data-view="pessoal"]').click();
    await restored.locator('#backupArquivo').setInputFiles({ name: 'copia.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(raw)) });
    assert.match(await restored.locator('#backupPrevia').innerText(), /1 registros financeiros/);
    await restored.locator('#backupRestaurar').click();
    await restored.waitForFunction(() => document.getElementById('backupStatus').textContent.includes('Restaurado:'));
    assert.equal(await restored.evaluate(() => JarvisFin.lista().length), 1);
    assert.equal(await restored.evaluate(() => JarvisPessoal.ler().perfil.compartilhar), false);
    assert.equal(await restored.evaluate(() => JarvisPessoal.ler().tarefas.length), 1);
    await second.close(); await context.close();
  }
  console.log('Backup: baixar e restaurar passaram em 1280px e 390px.');
} finally { await browser.close(); }
