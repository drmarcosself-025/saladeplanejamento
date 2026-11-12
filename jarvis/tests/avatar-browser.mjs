// Validação visual isolada, sem contatos, informações pessoais ou ações externas.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require(process.env.JARVIS_PLAYWRIGHT || process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright')); }
const binary = process.env.CHROMIUM_PATH || (!process.env.CI && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({headless:true,...(binary?{executablePath:binary}:{}),args:['--no-sandbox']});
const output=process.env.JARVIS_SCREENSHOTS||'/tmp/jarvis-screenshots';mkdirSync(output,{recursive:true});
try {
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'}),page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.JARVIS_TEST_URL||'http://localhost:8000');
    await page.evaluate(()=>{
      const c=document.createElement('canvas');c.id='qa-avatar';c.style.cssText='position:fixed;inset:0;width:390px;height:460px;z-index:999;background:#080c13';document.body.append(c);
      window.qaAvatar=JarvisAvatar.criar(c);
    });
    for(const state of ['idle','ouvindo','pensando','falando','executando']){
      await page.evaluate(s=>{window.qaAvatar.setEstado(s);window.qaAvatar.setNivel(.7);},state);
      await page.waitForFunction(()=>document.getElementById('qa-avatar').dataset.rendered==='true');
      assert.equal(await page.locator('#qa-avatar').getAttribute('data-renderer'),'cinematografico');
      const pixel=await page.evaluate(()=>{
        const c=document.getElementById('qa-avatar'),r=c.getBoundingClientRect(),s=Math.min(r.height/2.52,r.width/2.18),d=c.width/r.width;
        return [...c.getContext('2d').getImageData(Math.round((r.width*.5+.16*s)*d),Math.round((r.height*.035+.548*s)*d),1,1).data];
      });
      if(state==='idle'||state==='falando')assert.ok(pixel[0]>pixel[2],state+' tem núcleo âmbar');
      if(state==='ouvindo')assert.ok(pixel[2]>pixel[0],state+' tem núcleo azul');
      if(state==='pensando')assert.ok(pixel[2]>pixel[1],state+' tem núcleo violeta');
      if(state==='executando')assert.ok(pixel[1]>pixel[0],state+' tem núcleo verde');
      if(width===1280)await page.locator('#qa-avatar').screenshot({path:`${output}/avatar-${state}.png`});
    }
    await page.evaluate(()=>{window.qaAvatar.destroy();document.getElementById('qa-avatar').remove();delete window.qaAvatar;});
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Avatar OK: desenho responsivo e cinco paletas conferidas nos pixels renderizados.');
}finally{await browser.close();}
