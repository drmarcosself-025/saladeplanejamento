// Dia a Dia: o Jarvis continua à frente ao falar/digitar; rotina, água, compromissos e feedback da semana.
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
    const pedir = async (t) => { await page.evaluate((t) => { document.getElementById('entrada').value = t; document.getElementById('barra').requestSubmit(); }, t); await page.waitForTimeout(900); };
    const dados = () => page.evaluate(() => ({ vista: document.body.dataset.vista, area: document.body.dataset.area || '', dock: document.body.dataset.dock || '', legenda: document.getElementById('legenda') ? document.getElementById('legenda').textContent : '' }));
    const visivel = () => page.evaluate(() => { const c = document.getElementById('avatar'), r = c.getBoundingClientRect(); return r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < innerHeight && r.left >= -1 && r.right <= innerWidth + 1; });
    // 1) falar/digitar NÃO tira o Jarvis do início
    await pedir('bom dia'); let d = await dados();
    assert.equal(d.vista, 'hoje', `${nome}: continua no início`); assert.equal(d.dock, '', `${nome}: sem dock`); assert.equal(await visivel(), true, `${nome}: Jarvis visível`);
    assert.match(await page.textContent('#respostaTitulo'), /Seu dia/, `${nome}: resumo do dia no cartão`);
    assert.doesNotMatch(await page.textContent('body'), /Claude não está disponível aqui/, `${nome}: saudação não cai no Claude`);
    // 2) registra rotina por voz
    await pedir('adiciona tarefa ligar para o contador'); await pedir('marca reunião com a contadora amanhã às 14h'); await pedir('bebi 2 copos de água'); await pedir('almocei');
    const guardado = await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis_rotina_v1')));
    assert.equal(guardado.compromissos.length, 1, `${nome}: compromisso salvo`); assert.equal(guardado.compromissos[0].hora, '14:00');
    assert.equal(Object.values(guardado.agua)[0], 2, `${nome}: água salva`); assert.deepEqual(Object.values(guardado.refeicoes)[0], ['almoco']);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis_pessoal_v3')).tarefas.length)), 1, `${nome}: prioridade salva`);
    // 3) o Dia a Dia abre sem tirar o Jarvis
    await pedir('resumo do dia'); d = await dados();
    assert.equal(d.area, 'rotina', `${nome}: Dia a Dia aberto`); assert.equal(await visivel(), true, `${nome}: Jarvis visível com o Dia a Dia`);
    assert.equal(await page.locator('#rotTarefas li:not(.muted)').count(), 1, `${nome}: prioridade listada`);
    assert.equal(await page.locator('#rotAgua i.cheio').count(), 2, `${nome}: 2 copos cheios`);
    await page.evaluate(() => document.getElementById('rotAguaMais').click()); assert.equal(await page.locator('#rotAgua i.cheio').count(), 3, `${nome}: botão de água`);
    // 4) semana e feedback
    await pedir('marca consulta hoje às 18h');
    await pedir('como está minha semana'); assert.equal(await page.evaluate(() => document.getElementById('rotSemana').hidden), false, `${nome}: semana aberta`);
    assert.equal(await page.locator('#rotDias .rot-dia').count(), 7, `${nome}: 7 dias`); assert.ok(await page.locator('#rotFeedback li').count() >= 6, `${nome}: feedback`);
    assert.match(await page.textContent('#rotFeedback'), /[12] compromissos? na semana/); assert.match(await page.textContent('#rotFeedback'), /Água: média/);
    // 5) amanhã mostra a reunião; o modo Dia a Dia abre a tela
    await pedir('o que tenho amanhã'); assert.match(await page.textContent('#respostaItens'), /14h · Reunião com a contadora/, `${nome}: amanhã`);
    // 4b) planejamento: dia específico, mês, ano e metas
    await pedir('o que tenho segunda'); assert.match(await page.textContent('#rotTitulo'), /segunda/i, `${nome}: abre a segunda`);
    await pedir('meta do mês: vender mais clareamentos'); await pedir('como está meu mês');
    assert.ok(await page.locator('#rotMes .rot-cel').count() >= 28, `${nome}: grade do mês`); assert.match(await page.textContent('#rotMes'), /Vender mais clareamentos/, `${nome}: meta do mês`);
    await page.locator('#rotMes .rot-cel').nth(5).click(); assert.equal(await page.evaluate(() => document.getElementById('rotDia').hidden), false, `${nome}: clicar no dia abre o dia`);
    await pedir('como está meu ano'); assert.equal(await page.locator('#rotAno .rot-mes-card').count(), 12, `${nome}: 12 meses`);
    await page.locator('#rotAno .rot-mes-card').nth(0).click(); assert.equal(await page.evaluate(() => document.getElementById('rotMes').hidden), false, `${nome}: clicar no mês abre o mês`);
    await page.evaluate(() => document.getElementById('rotSeg').click()); assert.ok(await page.locator('#rotMes .rot-cel').count() >= 28, `${nome}: navega para o próximo mês`);
    // início: faixa da semana e 10 atalhos
    await page.evaluate(() => document.getElementById('rotFechar').click()); assert.equal(await page.locator('#semanaMini .sem-dia').count(), 7, `${nome}: semana no início`);
    assert.equal(await page.locator('.orb-sat').count(), 10, `${nome}: 10 atalhos`);
    await page.evaluate(() => document.querySelectorAll('#semanaMini .sem-dia')[2].click()); assert.equal((await dados()).area, 'rotina', `${nome}: dia da semana abre o Dia a Dia`);
    await page.evaluate(() => document.getElementById('rotFechar').click()); await pedir('ativa o agente dia a dia');
    assert.equal((await dados()).area, 'rotina', `${nome}: modo Dia a Dia abre a rotina`);
    assert.doesNotMatch(await page.textContent('body'), /Paciente [A-F]\b/, `${nome}: sem pacientes de demonstração`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(overflow <= 1, `${nome}: sem rolagem horizontal (${overflow})`);
    assert.deepEqual(errors, [], `${nome}: sem erros`);
    if (process.env.JARVIS_SCREENSHOTS) await page.screenshot({ path: `${process.env.JARVIS_SCREENSHOTS}/rotina-${nome}.png` });
    await ctx.close();
  }
  console.log('rotina-browser: ok');
} finally { await browser.close(); }
