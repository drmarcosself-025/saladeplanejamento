// Jarvis sempre presente (dock), cor por agente e gestos. Sem contatos nem dados pessoais.
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
const AGENTES = [['gestao', 'ativa o agente dia a dia', [255, 210, 63]], ['leads', 'ativa o agente leads', [25, 230, 193]], ['social', 'ativa o agente social media', [255, 63, 191]], ['designer', 'ativa o agente designer', [255, 77, 94]], ['programador', 'ativa o agente programador', [43, 255, 136]]];
const perto = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 40);
try {
  for (const [nome, w, h, mobile] of [['desktop', 1280, 800, false], ['celular', 390, 844, true]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile }), page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem('jarvis_boot', '1'));
    await page.goto(url); await page.waitForSelector('.orb-sat'); await page.waitForTimeout(1500);
    await page.click('#btnMudo');
    // o avatar fica visível e NÃO coberto em todas as telas
    const visivel = () => page.evaluate(() => { const c = document.getElementById('avatar'), r = c.getBoundingClientRect(); if (r.width < 40 || r.height < 40) return false; const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!el && (el === c || !!el.closest('.center')); });
    const ir = (v) => page.evaluate((v) => document.querySelector(`.main-nav [data-view="${v}"]`).click(), v);
    const pedir = (t) => page.evaluate((t) => { document.getElementById('entrada').value = t; document.getElementById('barra').requestSubmit(); }, t);
    for (const v of ['espacos', 'pessoal']) { await ir(v); await page.waitForTimeout(700); assert.equal(await visivel(), true, `${nome}: Jarvis visível em ${v}`); }
    await ir('hoje'); await pedir('abre o CRM'); await page.waitForTimeout(1200); assert.equal(await visivel(), true, `${nome}: Jarvis visível com o CRM aberto`);
    assert.equal(await page.evaluate(() => document.body.dataset.area), 'crm'); await page.evaluate(() => document.getElementById('crmFechar').click());
    await ir('hoje'); await pedir('ativa o agente contador'); await page.waitForTimeout(1200); assert.equal(await visivel(), true, `${nome}: Jarvis visível com o Contador aberto`);
    await page.evaluate(() => document.getElementById('finFechar').click()); await ir('hoje'); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.body.dataset.dock || ''), '', `${nome}: sem dock na tela Hoje`);
    // cor por agente: o avatar assume a cor e a interface acompanha
    for (const [id, cmd, rgb] of AGENTES) {
      await pedir(cmd); await page.waitForTimeout(2200);
      const r = await page.evaluate(() => ({ ag: JarvisAvatar.principal.corAgente, ui: getComputedStyle(document.documentElement).getPropertyValue('--estado-rgb').trim().split(' ').map(Number) }));
      assert.ok(r.ag && perto(r.ag, rgb), `${nome}: avatar na cor do agente ${id}`);
      assert.ok(perto(r.ui, rgb), `${nome}: interface na cor do agente ${id} (${r.ui})`);
    }
    await pedir('volta ao normal'); await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => JarvisAvatar.principal.corAgente), null, `${nome}: normal volta à referência`);
    if (!mobile) {   // gestos
      const box = await (await page.$('#avatar')).boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.keyboard.down('Control'); await page.mouse.move(cx, cy); await page.mouse.wheel(0, -300); await page.keyboard.up('Control'); await page.waitForTimeout(400);
      assert.ok(await page.evaluate(() => JarvisAvatar.principal.zoom) > 1.05, 'Ctrl+roda amplia');
      await page.evaluate(() => JarvisAvatar.principal.resetar()); await page.mouse.dblclick(cx, cy - 40); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => Math.round(JarvisAvatar.principal.zoom)), 2, 'duplo clique amplia');
    } else {
      const nav = await page.evaluate(() => { const n = document.querySelector('.main-nav').getBoundingClientRect(); return n.bottom >= innerHeight - 2; });
      assert.equal(nav, true, 'barra de navegação no rodapé do celular');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'sem rolagem horizontal');
    }
    assert.deepEqual(errors, [], `${nome}: sem erros de script`);
    await ctx.close();
  }
  console.log('Vida OK: Jarvis presente em todas as telas, cor por agente e gestos.');
} finally { await browser.close(); }
