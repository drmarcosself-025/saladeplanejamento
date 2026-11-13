// Contador 2.0: gráfico de 6 meses, variação, filtros, despesas fixas (sem duplicar), conferência e fechamento.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require(process.env.JARVIS_PLAYWRIGHT || process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright')); }
const binary = process.env.CHROMIUM_PATH || (!process.env.CI && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const url = process.env.JARVIS_TEST_URL || 'http://localhost:8000';
const browser = await chromium.launch({ headless: true, ...(binary ? { executablePath: binary } : {}), args: ['--no-sandbox'] });
try {
  for (const [nome, w, h, mobile] of [['desktop', 1280, 800, false], ['celular', 390, 844, true]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile }), page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem('jarvis_boot', '1'));
    await page.goto(url); await page.waitForSelector('.orb-sat'); await page.waitForTimeout(1200); await page.click('#btnMudo');
    const pedir = async (t) => { await page.evaluate((t) => { document.getElementById('entrada').value = t; document.getElementById('barra').requestSubmit(); }, t); await page.waitForTimeout(700); };
    const n = (sel) => page.locator(sel).count();
    await pedir('ativa o agente contador'); await pedir('abre o contador'); await page.waitForSelector('#finTela:not([hidden])');
    // estado vazio: alerta de conferência e gráfico com 6 meses
    assert.equal(await n('#finTendencia .fin-mes'), 6, `${nome}: 6 meses no gráfico`);
    assert.match(await page.textContent('#finConferencia'), /Nenhum lançamento/, `${nome}: conferência com mês vazio`);
    // lançamentos por voz e variação
    await pedir('recebi 5000 de consultas'); await pedir('lança despesa 412,90 energia'); await pedir('conta de internet 189,90 vence dia 20');
    assert.equal(await n('#finLista li'), 3, `${nome}: 3 lançamentos`);
    assert.ok(await n('#finCategorias .cat') >= 1, `${nome}: barras de categoria`);
    // filtro A pagar
    await page.evaluate(() => [...document.querySelectorAll('#finFiltros .chip')].find((b) => b.textContent === 'A pagar').click());
    assert.equal(await n('#finLista li'), 1, `${nome}: filtro A pagar`);
    await page.evaluate(() => [...document.querySelectorAll('#finFiltros .chip')].find((b) => b.textContent === 'Todos').click());
    // despesa fixa: cadastrar por voz e lançar duas vezes não duplica
    await pedir('cadastra despesa fixa aluguel 2800 dia 25'); assert.equal(await n('#finFixas li:not(.muted)'), 1, `${nome}: fixa cadastrada`);
    await pedir('lança as fixas do mês'); assert.equal(await n('#finLista li'), 4, `${nome}: fixa lançada`);
    await pedir('lança as fixas do mês'); assert.equal(await n('#finLista li'), 4, `${nome}: lançar de novo não duplica`);
    await page.evaluate(() => document.getElementById('finLancarFixas').click()); await page.waitForTimeout(400);
    assert.equal(await n('#finLista li'), 4, `${nome}: botão também não duplica`);
    // conferência: contas pendentes não impedem fechar; categoria revisada
    assert.equal(await n('#finConferencia li.alerta'), 0, `${nome}: sem alertas: ${await page.textContent('#finConferencia')}`);
    // fechamento + aviso de mudança
    await page.evaluate(() => document.getElementById('finFecharMes').click()); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.getElementById('finBanner').hidden), false, `${nome}: banner de fechado`);
    await pedir('recebi 100 de extra');
    assert.match(await page.textContent('#finBanner'), /mudaram depois/, `${nome}: avisa que mudou após fechar`);
    assert.equal(await n('#finConferencia li.alerta'), 1, `${nome}: alerta de mudança`);
    // clicar em outro mês no gráfico
    await page.evaluate(() => document.querySelectorAll('#finTendencia .fin-mes')[4].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(await n('#finLista li.muted'), 1, `${nome}: mês anterior vazio`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${nome}: sem rolagem horizontal (${overflow})`);
    assert.deepEqual(errors, [], `${nome}: sem erros`);
    if (process.env.JARVIS_SCREENSHOTS) await page.screenshot({ path: `${process.env.JARVIS_SCREENSHOTS}/contador-${nome}.png` });
    await ctx.close();
  }
  console.log('contador-browser: ok');
} finally { await browser.close(); }
