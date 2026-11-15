// Social Media + central de avisos: comentários, calendário, avisos proativos, sem inventar Instagram.
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
    const pedir = async (t) => { await page.evaluate((t) => { document.getElementById('entrada').value = t; document.getElementById('barra').requestSubmit(); }, t); await page.waitForTimeout(800); };
    const area = () => page.evaluate(() => document.body.dataset.area || '');
    const visivel = () => page.evaluate(() => { const c = document.getElementById('avatar'), r = c.getBoundingClientRect(); return r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < innerHeight; });
    // Instagram: honestidade
    await pedir('como está meu instagram'); assert.equal(await area(), 'social', `${nome}: abre o Social`);
    assert.match(await page.textContent('#legenda'), /não consigo ver seu Instagram ao vivo/, `${nome}: não finge acesso ao Instagram`);
    // comentários
    await pedir('anota comentário de @maria: quanto custa o clareamento'); assert.equal(await page.locator('#socComentarios li:not(.muted)').count(), 1, `${nome}: comentário anotado`);
    assert.match(await page.textContent('#respostaItens'), /direct/, `${nome}: respostas sugeridas`);
    await pedir('quais comentários preciso responder'); assert.match(await page.textContent('#respostaItens'), /@maria: quanto custa/, `${nome}: lista de comentários`);
    // calendário de posts
    await pedir('agenda um reels sobre clareamento hoje'); await pedir('planeja post de implante dia 28');
    assert.equal(await page.locator('#socPosts li:not(.muted)').count(), 2, `${nome}: 2 posts`);
    await pedir('calendário de posts'); assert.match(await page.textContent('#respostaItens'), /Reels · Clareamento/, `${nome}: calendário`);
    // avisos
    await page.evaluate(() => document.getElementById('socFechar').click());
    await pedir('quais minhas notificações'); const card = await page.textContent('#respostaItens');
    assert.match(card, /comentário esperando resposta/, `${nome}: aviso de comentário`); assert.match(card, /post planejado para hoje/, `${nome}: aviso de post`);
    assert.equal(await visivel(), true, `${nome}: Jarvis à frente`);
    await pedir('respondi a Maria'); await pedir('quais minhas notificações'); assert.doesNotMatch(await page.textContent('#respostaItens'), /comentário esperando/, `${nome}: aviso some depois de responder`);
    // modo Social
    await pedir('ativa o agente social media'); assert.equal(await area(), 'social', `${nome}: modo abre a tela`);
    assert.doesNotMatch(await page.textContent('body'), /Erros de envio|posts esperando aprovação/, `${nome}: sem dados de demonstração`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(overflow <= 1, `${nome}: sem rolagem horizontal (${overflow})`);
    assert.deepEqual(errors, [], `${nome}: sem erros`);
    if (process.env.JARVIS_SCREENSHOTS) await page.screenshot({ path: `${process.env.JARVIS_SCREENSHOTS}/social-${nome}.png` });
    await ctx.close();
  }
  console.log('social-browser: ok');
} finally { await browser.close(); }
