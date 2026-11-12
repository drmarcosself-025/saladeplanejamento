// Presença anatômica estilizada: mandíbula, orelhas, pescoço, clavículas e tórax.
// A malha é decorativa; a luz central comunica o estado real da interface.
(function () {
  const TAU = Math.PI * 2;
  const PALETAS = {
    idle:       { cor: [255, 175, 62], claro: [255, 246, 192] },
    ouvindo:    { cor: [56, 211, 255], claro: [201, 248, 255] },
    pensando:   { cor: [167, 115, 255], claro: [232, 211, 255] },
    falando:    { cor: [255, 145, 46], claro: [255, 236, 171] },
    executando: { cor: [63, 233, 167], claro: [200, 255, 229] },
  };
  const cabeca = [[0,0],[.035,.13],[.12,.26],[.25,.345],[.43,.375],[.60,.37],[.76,.345],[.89,.30],[1.01,.225],[1.095,.135],[1.135,.06],[1.15,0]];
  // O pescoço começa atrás da mandíbula e alarga progressivamente no trapézio.
  const corpo = [[.91,.235],[1.06,.218],[1.19,.195],[1.30,.215],[1.39,.29],[1.47,.42],[1.54,.64],[1.63,.82],[1.76,.945],[1.92,.98],[2.13,.955],[2.32,.90]];
  const limitar = (n, a, b) => Math.max(a, Math.min(b, n));
  function perfil(pontos, y) {
    if (y <= pontos[0][0]) return pontos[0][1];
    if (y >= pontos[pontos.length-1][0]) return pontos[pontos.length-1][1];
    const i = pontos.findIndex((p,j) => j < pontos.length-1 && y >= p[0] && y <= pontos[j+1][0]);
    const a = pontos[Math.max(0,i-1)], b = pontos[i], c = pontos[i+1], d = pontos[Math.min(pontos.length-1,i+2)];
    const t = (y-b[0])/(c[0]-b[0]), h = c[0]-b[0];
    const m0 = (c[1]-a[1])/(c[0]-a[0]), m1 = (d[1]-b[1])/(d[0]-b[0]);
    return Math.max(0,(2*t*t*t-3*t*t+1)*b[1]+(t*t*t-2*t*t+t)*h*m0+(-2*t*t*t+3*t*t)*c[1]+(t*t*t-t*t)*h*m1);
  }
  const gauss = (x,y,cx,cy,sx,sy,a) => a*Math.exp(-Math.pow((x-cx)/sx,2)-Math.pow((y-cy)/sy,2));
  const bezier = (p,t) => p[0].map((_,i) => (1-t)**3*p[0][i]+3*(1-t)**2*t*p[1][i]+3*(1-t)*t*t*p[2][i]+t**3*p[3][i]);
  const amostrar = (p,n=30) => Array.from({length:n},(_,i)=>bezier(p,i/(n-1)));
  const rand = i => { const n = Math.sin(i*127.1+311.7)*43758.5453; return n-Math.floor(n); };
  function criar(canvas) {
    const ctx = canvas.getContext('2d');
    const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches, mobile = innerWidth < 700;
    let W=1,H=1,estado='idle',nivel=0,last=-Infinity,raf=0,ativo=true;
    let luz=PALETAS.idle.cor.slice(),claro=PALETAS.idle.claro.slice();
    let corModo=[48,208,255];
    const resize=()=>{
      const box=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,mobile?1.5:2);
      W=Math.max(1,box.width);H=Math.max(1,box.height);canvas.width=W*d;canvas.height=H*d;ctx.setTransform(d,0,0,d,0,0);
      last=-Infinity;delete canvas.dataset.rendered;
    };
    const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
    function superficie(u,y,parte) {
      const head=parte==='cabeca',x=u*perfil(head?cabeca:corpo,y),curva=Math.sqrt(Math.max(0,1-u*u));
      let z=curva*(head?.25:y<1.36?.155:.20);
      if(head){
        // Testa, zigoma e mandíbula discretos; sem olhos ou órbitas desenhadas.
        z+=gauss(x,y,0,.63,.075,.20,.055)+gauss(x,y,0,1.03,.15,.10,.02);
      }else{
        z+=gauss(x,y,-.40,1.83,.31,.30,.09)+gauss(x,y,.40,1.83,.31,.30,.09);
        z+=gauss(x,y,0,1.29,.065,.12,.035);
        z-=gauss(x,y,0,1.49,.09,.07,.045);
      }
      return[x,y,z];
    }
    function frame(ms){
      if(!ativo)return;raf=requestAnimationFrame(frame);
      if(document.hidden||W<3||H<3||ms-last<(quiet?180:32))return;
      last=ms;
      const t=quiet?0:ms/1000,s=Math.min(H/2.52,W/2.18),cx=W*.5,oy=H*.035;
      const yaw=.065+(quiet?0:Math.sin(t*.19)*.035),breath=quiet?0:Math.sin(t*1.15)*.004;
      const proj=([x,y,z])=>[cx+(x*Math.cos(yaw)+z*Math.sin(yaw))*s,oy+(y-z*.09+breath)*s];
      const pal=PALETAS[estado]||PALETAS.idle;
      luz=luz.map((v,i)=>v+(pal.cor[i]-v)*(quiet?1:.13));claro=claro.map((v,i)=>v+(pal.claro[i]-v)*(quiet?1:.13));
      const rgb=corModo.map(Math.round).join(','),lrgb=luz.map(Math.round).join(','),hot=claro.map(Math.round).join(',');
      const stroke=(pts,alpha=.4,width=.7,glow=0,color=rgb)=>{
        ctx.strokeStyle=`rgba(${color},${alpha})`;ctx.lineWidth=width;ctx.shadowBlur=glow;ctx.shadowColor=`rgba(${color},.8)`;
        ctx.beginPath();pts.forEach((p,i)=>{const a=proj(p);i?ctx.lineTo(...a):ctx.moveTo(...a)});ctx.stroke();ctx.shadowBlur=0;
      };
      const curve=(p,a,w,g,c)=>stroke(amostrar(p),a,w,g,c);
      ctx.clearRect(0,0,W,H);
      const core=proj([0,.575,.295]);
      const ambient=ctx.createRadialGradient(core[0],core[1],0,core[0],core[1],s*.95);
      ambient.addColorStop(0,'rgba(20,145,218,.11)');ambient.addColorStop(1,'rgba(0,50,100,0)');ctx.fillStyle=ambient;ctx.fillRect(0,0,W,H);
      // Volume do pescoço e do tórax, atrás da mandíbula.
      const br=mobile?62:84;
      for(let j=0;j<br;j++){
        const y=.96+j/(br-1)*1.36;
        stroke(Array.from({length:43},(_,k)=>superficie(k/21-1,y,'corpo')),y<1.19?.10:y<1.42?.30:.16,.65);
      }
      for(let k=1;k<(mobile?22:30);k++){
        const u=k/(mobile?22:30)*2-1;
        stroke(Array.from({length:62},(_,j)=>superficie(u,.98+j/61*1.34,'corpo')),.15,.6);
      }
      // Trapézios e deltoides arredondados, em continuidade com os ombros.
      for(const side of[-1,1]){
        const edge=Array.from({length:80},(_,j)=>{const y=.99+j/79*1.33;return superficie(side,y,'corpo')});
        stroke(edge,.14,3.2,12);stroke(edge,.65,1.05,4);
        curve([[side*.68,1.58,.14],[side*.88,1.62,.20],[side*.99,1.89,.15],[side*.86,2.17,.13]],.30,.85,2);
        // Esternocleidomastoideo ligando a mandíbula ao esterno.
        curve([[side*.255,1.00,.10],[side*.21,1.17,.21],[side*.15,1.39,.24],[side*.065,1.515,.25]],.65,1.05,4);
        curve([[side*.23,1.04,.11],[side*.19,1.22,.22],[side*.11,1.39,.23],[side*.02,1.50,.24]],.24,.65);
        // Clavícula em S, ligada à incisura supraesternal.
        curve([[side*.025,1.535,.25],[side*.18,1.60,.28],[side*.34,1.445,.26],[side*.68,1.58,.15]],.73,1.05,4);
        curve([[side*.04,1.56,.245],[side*.22,1.62,.275],[side*.37,1.49,.25],[side*.65,1.61,.16]],.25,.65);
        // Peitorais e linhas laterais do busto.
        for(let k=0;k<4;k++)curve([[side*.10,1.63+k*.045,.28],[side*.30,1.57+k*.13,.34],[side*.70,1.72+k*.13,.31],[side*.88,1.98+k*.065,.16]],.13,.65);
      }
      curve([[-.07,1.49,.24],[-.035,1.57,.24],[.035,1.57,.24],[.07,1.49,.24]],.50,.85,2);
      // Ramificações orgânicas conectam garganta, esterno e peito.
      const trunk=[[0,1.13,.23],[.018,1.41,.25],[-.018,1.77,.31],[0,2.29,.29]];
      curve(trunk,.24,2.8,7,lrgb);curve(trunk,.75,.9,3,lrgb);
      for(const side of[-1,1])for(let j=0;j<3;j++){
        const start=bezier(trunk,.17+j*.15),end=[side*(.35+j*.19),2.23-j*.08,.27-j*.02];
        const branch=[start,[side*.07,start[1]+.12,.30],[side*(.23+j*.16),1.78+j*.07,.34],end];
        curve(branch,.20,2,5,lrgb);curve(branch,.57,.65,2);
        for(let k=0;k<2;k++){
          const a=bezier(branch,.48+k*.18),b=[a[0]+side*(.13+j*.035),a[1]+.10,.29],d=[a[0]+side*(.23+j*.025),a[1]+.25-k*.04,.20];
          curve([a,b,[d[0]-side*.025,d[1]-.08,.25],d],.34,.6,2);
        }
        if(!quiet){const f=(t*.18+j*.23)%1,p=proj(bezier(branch,f));ctx.fillStyle=`rgba(${lrgb},.7)`;ctx.beginPath();ctx.arc(...p,1.05,0,TAU);ctx.fill()}
      }
      // Pequenas orelhas com hélice, concha e lóbulo.
      for(const side of[-1,1]){
        curve([[side*.365,.48,.045],[side*.47,.42,.025],[side*.47,.70,.04],[side*.352,.825,.07]],.64,.95,4);
        curve([[side*.38,.535,.08],[side*.43,.49,.09],[side*.44,.66,.09],[side*.38,.74,.09]],.39,.7,2);
        curve([[side*.389,.58,.11],[side*.422,.57,.12],[side*.411,.67,.12],[side*.38,.69,.12]],.25,.65);
      }
      // A mandíbula passa à frente da porção superior do pescoço.
      const outline=[...Array.from({length:56},(_,j)=>superficie(-1,j/55*1.15,'cabeca')),...Array.from({length:56},(_,j)=>superficie(1,1.15-j/55*1.15,'cabeca'))];
      ctx.beginPath();outline.forEach((p,i)=>{const a=proj(p);i?ctx.lineTo(...a):ctx.moveTo(...a)});ctx.closePath();ctx.fillStyle='rgba(5,18,29,.90)';ctx.fill();
      const wave=quiet?0:Math.abs(Math.sin(t*(estado==='falando'?6:1.6)));
      const power=estado==='ouvindo'?1+nivel*.20:estado==='falando'?1+wave*.12:estado==='pensando'?1.05:1+wave*.035;
      // Projeção oval, ampla e centralizada, com luz difusa.
      ctx.save();ctx.translate(...core);ctx.scale(.77,1.15);ctx.globalCompositeOperation='lighter';
      const radius=s*.39*power,g=ctx.createRadialGradient(0,0,0,0,0,radius);
      g.addColorStop(0,`rgba(${hot},.90)`);g.addColorStop(.18,`rgba(${hot},.70)`);g.addColorStop(.39,`rgba(${lrgb},.65)`);g.addColorStop(.70,`rgba(${lrgb},.22)`);g.addColorStop(1,`rgba(${lrgb},0)`);
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(0,0,radius,0,TAU);ctx.fill();ctx.restore();
      ctx.globalCompositeOperation='lighter';
      const hr=mobile?55:75;
      for(let j=1;j<hr;j++)stroke(Array.from({length:43},(_,k)=>superficie(k/21-1,j/hr*1.15,'cabeca')),.33,.65);
      for(let k=1;k<(mobile?21:29);k++){
        const u=k/(mobile?21:29)*2-1;stroke(Array.from({length:52},(_,j)=>superficie(u,j/51*1.15,'cabeca')),.16,.55);
      }
      for(const side of[-1,1]){
        const edge=Array.from({length:75},(_,j)=>superficie(side,j/74*1.15,'cabeca'));
        stroke(edge,.17,3,13);stroke(edge,.70,1.0,4);
      }
      // Boca discreta; sem olhos, pupilas ou sobrancelhas.
      const ouverture=estado==='falando'&&!quiet?Math.abs(Math.sin(t*6.5))*.014:0;
      curve([[-.11,.947,.29],[-.035,.936,.315],[.035,.936,.315],[.11,.947,.29]],.23,.7);
      curve([[-.085,.958,.29],[-.03,.963+ouverture,.31],[.03,.963+ouverture,.31],[.085,.958,.29]],.15,.65);
      // Núcleo luminoso elíptico, alongado no eixo vertical.
      const pcore=ctx.createRadialGradient(core[0],core[1],0,core[0],core[1],s*.16);
      pcore.addColorStop(0,`rgba(${hot},.48)`);pcore.addColorStop(1,`rgba(${lrgb},0)`);
      ctx.fillStyle=pcore;ctx.shadowColor=`rgb(${lrgb})`;ctx.shadowBlur=18;ctx.beginPath();ctx.ellipse(core[0],core[1],s*.074*power,s*.16*power,0,0,TAU);ctx.fill();ctx.shadowBlur=0;
      // Partículas leves ao redor do crânio e dos ombros.
      for(let i=0;i<(mobile?100:170);i++){
        const y=rand(i+7)*2.12,a=rand(i+503)*TAU,w=perfil(y<1.15?cabeca:corpo,y)+.02+rand(i+203)*.07;
        const drift=quiet?0:Math.sin(t*.4+i)*.008,p=proj([Math.cos(a)*w+drift,y+drift,Math.sin(a)*.20]);
        ctx.fillStyle=`rgba(${rgb},${.10+rand(i+29)*.30})`;ctx.fillRect(p[0],p[1],.65,.65);
      }
      ctx.globalCompositeOperation='source-over';canvas.dataset.rendered='true';canvas.dataset.estado=estado;
    }
    raf=requestAnimationFrame(frame);
    return{
      setEstado(e){estado=PALETAS[e]?e:'idle';last=-Infinity;delete canvas.dataset.rendered;},
      setCor(h){const n=parseInt(String(h).replace('#',''),16);if(Number.isFinite(n))corModo=[48+((n>>16)&255)*.03,202+((n>>8)&255)*.04,250];},
      setNivel(n){nivel=limitar(n||0,0,1);},
      destroy(){ativo=false;cancelAnimationFrame(raf);observer.disconnect();},
    };
  }
  window.JarvisAvatar={criar};
})();
