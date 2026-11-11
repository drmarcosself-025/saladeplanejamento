// Presença 3.0: rosto tridimensional em malha, luz suave e movimento contido.
// Canvas nativo; sem imagens, rastreamento ou dados biométricos.
(function () {
  const TAU = Math.PI * 2;
  function criar(canvas) {
    const ctx = canvas.getContext("2d");
    const quiet = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 1, H = 1, estado = "idle", nivel = 0, cor = [145, 214, 221], alvo = cor.slice(), last = -Infinity;
    const hex = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n>>16)&255,(n>>8)&255,n&255]; };
    const resize = () => { const box = canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); W = Math.max(1, box.width); H = Math.max(1, box.height); canvas.width = W*d; canvas.height = H*d; ctx.setTransform(d,0,0,d,0,0); last = -Infinity; delete canvas.dataset.rendered; };
    new ResizeObserver(resize).observe(canvas); resize();
    // Leve relevo facial: testa, maçãs do rosto, nariz e queixo.
    function geo(u, v) {
      const y = v * 1.55 - .77;
      const jaw = v > .67 ? 1 - (v-.67)*.85 : 1;
      const x = u * Math.sqrt(Math.max(0,1-Math.pow((v-.47)/.53,2))) * .47 * jaw;
      const z0 = Math.sqrt(Math.max(0,1-(u*u))) * .21;
      const bump = (cx,cy,sx,sy,a) => a*Math.exp(-Math.pow((x-cx)/sx,2)-Math.pow((y-cy)/sy,2));
      let z = z0 + bump(0,.02,.075,.26,.22) + bump(0,.15,.12,.08,.09) + bump(-.21,.09,.15,.12,.035) + bump(.21,.09,.15,.12,.035);
      z -= bump(-.18,-.1,.13,.07,.055) + bump(.18,-.1,.13,.07,.055);
      return [x,y,z];
    }
    function frame(ms) {
      requestAnimationFrame(frame);
      if (document.hidden || W < 3 || H < 3 || (quiet && ms-last < 180)) return;
      last=ms; const t=ms/1000, s=Math.min(H*.70,W*.68), cx=W/2, cy=H*.49;
      cor=cor.map((v,i)=>v+(alvo[i]-v)*.04);
      // Harmoniza os modos numa paleta de gelo, sem flash de cores saturadas.
      const rgb=cor.map((v,i)=>Math.round(v*.28+[145,214,221][i]*.72)).join(",");
      const yaw=quiet?.12:.12+Math.sin(t*.28)*.075;
      const breath=quiet?0:Math.sin(t*1.25)*1.2;
      const project=([x,y,z])=>[cx+(x*Math.cos(yaw)+z*Math.sin(yaw))*s,cy+(y*.87-z*.09)*s+breath];
      const line=(pts,color,width=1)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();pts.forEach((p,i)=>{const [x,y]=project(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()};
      ctx.clearRect(0,0,W,H);
      const glow=ctx.createRadialGradient(cx,cy,0,cx,cy,s*.75);glow.addColorStop(0,`rgba(${rgb},.07)`);glow.addColorStop(.6,`rgba(${rgb},.018)`);glow.addColorStop(1,`rgba(${rgb},0)`);ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);
      // Órbitas elípticas finas, com um único ponto em movimento.
      for(let j=0;j<3;j++){
        const rad=s*(.60+j*.095);ctx.strokeStyle=`rgba(${rgb},${.10-j*.025})`;ctx.lineWidth=.65;ctx.beginPath();ctx.ellipse(cx,cy,rad,rad*.93,-.22,0,TAU);ctx.stroke();
        if(!quiet){const a=t*(.14+j*.04)+j*2;ctx.fillStyle=`rgba(${rgb},.55)`;ctx.beginPath();ctx.arc(cx+Math.cos(a)*rad,cy+Math.sin(a)*rad*.93,1.5,0,TAU);ctx.fill()}
      }
      // Busto e ombros, deliberadamente secundários ao rosto.
      for(let k=0;k<12;k++){
        const f=k/11,y=.55+f*.42, width=.12+Math.sin(f*Math.PI/2)*.73;
        line(Array.from({length:31},(_,i)=>{const x=(i/30*2-1)*width;return[x,y+Math.abs(x)*.12,.04-f*.06]}),`rgba(${rgb},${.08+(1-f)*.05})`,.65);
      }
      // Malha do rosto. A densidade varia para parecer uma superfície, não um farol.
      const rows=W<500?37:47, cols=24;
      for(let j=1;j<rows;j++){
        const v=j/rows;const pts=Array.from({length:49},(_,i)=>geo(i/24-1,v));
        line(pts,`rgba(${rgb},${.12+Math.sin(v*Math.PI)*.15})`,.65);
      }
      for(let i=1;i<cols;i++){
        const u=i/cols*2-1;line(Array.from({length:49},(_,j)=>geo(u,j/48)),`rgba(${rgb},${.07+(1-Math.abs(u))*.08})`,.6);
      }
      // Olhos e sobrancelhas: expressão neutra, atenta e discreta.
      const blink=quiet?1:Math.pow(Math.max(0,Math.cos(t*.8)),50)>.85?.15:1;
      const eyeY=-.115;
      for(const side of [-1,1]){
        const ex=side*.175;
        line(Array.from({length:17},(_,i)=>{const f=i/16;return[ex+(f-.5)*.18,eyeY-Math.sin(f*Math.PI)*.022*blink,.255]}),`rgba(${rgb},.65)`,1.05);
        line(Array.from({length:15},(_,i)=>{const f=i/14;return[ex+(f-.5)*.19,eyeY-.074-Math.sin(f*Math.PI)*.014,.24]}),`rgba(${rgb},.33)`,.8);
        const dot=project([ex,eyeY,.265]);ctx.fillStyle=`rgba(${rgb},.8)`;ctx.beginPath();ctx.arc(dot[0],dot[1],s*.007,0,TAU);ctx.fill();
      }
      // Nariz e boca respondem sutilmente à fala.
      line([[0,-.23,.25],[.015,.05,.40],[.065,.14,.35],[0,.16,.43],[-.065,.14,.35]],`rgba(${rgb},.32)`,.8);
      const talking=estado==="falando"&&!quiet?Math.abs(Math.sin(t*7))* .018:0;
      line(Array.from({length:25},(_,i)=>{const f=i/24;return[(f-.5)*.25,.32+Math.sin(f*Math.PI)*(.012+talking),.255+Math.sin(f*Math.PI)*.035]}),`rgba(${rgb},.55)`,1);
      line(Array.from({length:17},(_,i)=>{const f=i/16;return[(f-.5)*.17,.38+Math.sin(f*Math.PI)*.009,.25]}),`rgba(${rgb},.20)`,.65);
      // Baliza de escuta e foco, sem animação agressiva.
      if(estado!=="idle"){
        const lev=estado==="ouvindo"?nivel:estado==="pensando"?.3:.15;
        ctx.strokeStyle=`rgba(${rgb},.45)`;ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(cx,cy,s*(.64+lev*.025),s*(.60+lev*.025),0,quiet?0:t*.35,quiet?TAU:t*.35+Math.PI*1.4);ctx.stroke();
      }
      // Poucos pontos de constelação, deterministicamente distribuídos.
      for(let i=0;i<20;i++){const a=i*2.399,rad=s*(.63+(i%5)*.045);const x=cx+Math.cos(a)*rad,y=cy+Math.sin(a)*rad*.9;ctx.fillStyle=`rgba(${rgb},${.12+(i%3)*.08})`;ctx.fillRect(x,y,1.2,1.2)}
      canvas.dataset.rendered = "true";
    }
    requestAnimationFrame(frame);
    return {setEstado(e){estado=e},setCor(h){alvo=hex(h)},setNivel(n){nivel=Math.max(0,Math.min(1,n||0))}};
  }
  window.JarvisAvatar={criar};
})();
