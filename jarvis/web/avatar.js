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
  function criarMalha(canvas) {
    const ctx = canvas.getContext('2d');
    const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches, mobile = innerWidth < 700;
    let W=1,H=1,estado='idle',nivel=0,last=-Infinity,raf=0,ativo=true;
    let luz=PALETAS.idle.cor.slice(),claro=PALETAS.idle.claro.slice();
    let corModo=[48,208,255];
    const resize=()=>{
      const box=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,mobile?1.5:2);
      W=Math.max(1,box.width);H=Math.max(1,box.height);
      if(canvas.width===Math.floor(W*d)&&canvas.height===Math.floor(H*d)){ctx.setTransform(d,0,0,d,0,0);return;}
      canvas.width=W*d;canvas.height=H*d;ctx.setTransform(d,0,0,d,0,0);
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
  // Base de acabamento cinematográfico + luz dinâmica extraída da rede interna.
  function criar(canvas) {
    const ctx=canvas.getContext('2d'),quiet=matchMedia('(prefers-reduced-motion: reduce)').matches,mobile=innerWidth<700;
    let W=1,H=1,raf=0,last=-Infinity,estado='idle',nivel=0,ativo=true,ready=false,fallback=null;
    let base,mask,energy,iw=1,ih=1,cor=PALETAS.idle.cor.slice();
    // Cor do agente: null = Jarvis de referência (estados em âmbar/azul/violeta/verde).
    // Com agente, veias, núcleo e brilho assumem a cor dele; o corpo recebe um tingimento suave.
    let corAg=null,tint=null,tintA=0,tintAlvo=0,tintOld=null,tintOldA=0;
    // Vida: respiração, balanço, cabeça que acena/inclina/olha conforme o estado, e o efeito de troca de agente.
    const scene=document.createElement('canvas'),sx=scene.getContext('2d');
    const pesos={idle:1,ouvindo:0,pensando:0,falando:0,executando:0};let envS=0,troca=null,estadoT=-1e9,dprAtual=1,corIni=true;
    let fase=0,velS=.17,luzS=.35;                       // fase da onda de energia (sobe pelas veias), velocidade e brilho da luz do rosto
    const parts=Array.from({length:mobile?14:26},()=>({x:.5+(Math.random()-.5)*.55,y:.3+Math.random()*.67,v:.05+Math.random()*.09,s:.6+Math.random()*1.3,a:.35+Math.random()*.5,ph:Math.random()*6.28}));
    const COR_NORMAL='#35b8ff';
    function prepararTint(){            // pré-calcula o corpo tingido (uma vez por troca de agente, não por quadro)
      if(!ready||!corAg)return;
      if(tint&&tintA>.05){tintOld=tint;tintOldA=tintA;}          // a cor anterior some enquanto a nova entra
      const c=criarBuffer(),x=c.getContext('2d');
      x.drawImage(base,0,0);x.globalCompositeOperation='hue';x.fillStyle=`rgb(${corAg.map(Math.round).join(',')})`;x.fillRect(0,0,iw,ih);
      x.globalCompositeOperation='destination-in';x.drawImage(base,0,0);x.globalCompositeOperation='source-over';
      tint=c;tintA=0;last=-Infinity;
    }
    const resize=()=>{
      const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,mobile?1.5:2);
      W=Math.max(1,r.width);H=Math.max(1,r.height);
      // O ResizeObserver dispara uma vez ao observar. Se o tamanho é o mesmo, não mexe: redimensionar apaga o desenho.
      dprAtual=d;
      if(canvas.width===Math.floor(W*d)&&canvas.height===Math.floor(H*d)){ctx.setTransform(d,0,0,d,0,0);return;}
      canvas.width=W*d;canvas.height=H*d;ctx.setTransform(d,0,0,d,0,0);
      scene.width=canvas.width;scene.height=canvas.height;sx.setTransform(d,0,0,d,0,0);
      last=-Infinity;delete canvas.dataset.rendered;
    };
    const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
    const img=new Image();
    const criarBuffer=()=>{const c=document.createElement('canvas');c.width=iw;c.height=ih;return c};
    const falhar=()=>{
      if(!ativo||fallback)return;cancelAnimationFrame(raf);observer.disconnect();
      fallback=criarMalha(canvas);fallback.setEstado(estado);fallback.setNivel(nivel);canvas.dataset.renderer='malha';
    };
    img.onload=()=>{
      if(!ativo)return;
      try{
        iw=mobile?480:720;ih=Math.round(iw*img.naturalHeight/img.naturalWidth);
        base=criarBuffer();mask=criarBuffer();energy=criarBuffer();
        const b=base.getContext('2d',{willReadFrequently:true}),m=mask.getContext('2d');b.drawImage(img,0,0,iw,ih);
        const pixels=b.getImageData(0,0,iw,ih),light=m.createImageData(iw,ih);
        for(let i=0;i<pixels.data.length;i+=4){
          const r=pixels.data[i],g=pixels.data[i+1],bl=pixels.data[i+2],alpha=pixels.data[i+3];
          if(!alpha)continue;
          const x=(i/4%iw)/iw,y=Math.floor(i/4/iw)/ih,lum=r*.30+g*.59+bl*.11;
          let warm=limitar((r-bl*.95-8)/70,0,1)*limitar((r-g*.9+6)/65,0,1);
          const face=Math.exp(-Math.pow((x-.50)/.13,2)-Math.pow((y-.255)/.16,2));
          warm=Math.max(warm,face*limitar((lum-145)/95,0,1));
          pixels.data[i]=r*(1-warm)+lum*.12*warm;
          pixels.data[i+1]=g*(1-warm)+lum*.24*warm;
          pixels.data[i+2]=bl*(1-warm)+lum*.29*warm;
          light.data[i]=light.data[i+1]=light.data[i+2]=255;
          light.data[i+3]=Math.min(255,Math.pow(lum/255,.70)*warm*alpha);
        }
        b.putImageData(pixels,0,0);m.putImageData(light,0,0);ready=true;last=-Infinity;if(corAg)prepararTint();
      }catch(_){falhar()}
    };
    img.onerror=falhar;
    img.src=window.JARVIS_AVATAR_ASSET||'assets/jarvis-live-action.webp';

    // ---------- toque, arrastar e ampliar ----------
    // Arrastar inclina o busto (a mola o traz de volta); com zoom, arrasta a imagem.
    // Pinça, Ctrl/⌘+roda ou duplo toque ampliam; tocar faz a energia correr a partir do ponto.
    // Sem toque, tudo fica em zero e o desenho é idêntico ao padrão.
    let zoom=1,zoomAlvo=1,panX=0,panY=0,panAX=0,panAY=0,tiltX=0,tiltY=0,tiltAX=0,tiltAY=0,inter=-1e9,toque=null,ultToque=null,geo=null,cbToque=null,nivelAtual=0;
    const pts=new Map();let ultDist=0,moveu=false,downXY=[0,0];
    const MAXZ=2.6,agora=()=>performance.now();
    const interagir=()=>{inter=agora();last=-Infinity;};
    const limitarPan=()=>{const mx=(zoomAlvo-1)*W*.55,my=(zoomAlvo-1)*H*.55;panAX=limitar(panAX,-mx,mx);panAY=limitar(panAY,-my,my);};
    const local=e=>{const r=canvas.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top];};
    const distancia=()=>{const a=[...pts.values()];return a.length<2?0:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);};
    function definirZoom(z,px,py){            // amplia mantendo o ponto (px,py) parado
      const antes=zoomAlvo;zoomAlvo=limitar(z,1,MAXZ);
      if(px!=null&&antes>0){const k=zoomAlvo/antes;panAX=(px-W/2)-(px-W/2-panAX)*k;panAY=(py-H/2)-(py-H/2-panAY)*k;}
      if(zoomAlvo<=1.001){panAX=panAY=0;}
      limitarPan();canvas.style.touchAction=zoomAlvo>1.02?'none':'pan-y';interagir();
    }
    function tocarEm(px,py){
      const t=agora();toque={x:px,y:py,t};
      if(cbToque)cbToque({x:px/W,y:py/H});
      if(ultToque&&t-ultToque.t<360&&Math.hypot(px-ultToque.x,py-ultToque.y)<48){definirZoom(zoomAlvo>1.05?1:2,px,py);ultToque=null;}
      else ultToque={x:px,y:py,t};
      interagir();
    }
    canvas.style.touchAction='pan-y';canvas.style.cursor='grab';canvas.style.userSelect='none';canvas.tabIndex=0;canvas.setAttribute('role','img');
    canvas.addEventListener('pointerdown',e=>{
      const [x,y]=local(e);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
      try{canvas.setPointerCapture(e.pointerId);}catch(_){}
      moveu=false;downXY=[e.clientX,e.clientY];if(pts.size===2)ultDist=distancia();
      canvas.style.cursor='grabbing';interagir();
    });
    canvas.addEventListener('pointermove',e=>{
      const p=pts.get(e.pointerId);if(!p)return;
      const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
      if(pts.size>=2){const d=distancia();if(ultDist>0)definirZoom(zoomAlvo*d/ultDist);ultDist=d;moveu=true;}
      else{
        if(Math.hypot(e.clientX-downXY[0],e.clientY-downXY[1])>6)moveu=true;
        if(zoomAlvo>1.02){panAX+=dx;panAY+=dy;limitarPan();}
        else{tiltAX=limitar(tiltAX+dx/(W*.30),-1,1);tiltAY=limitar(tiltAY+dy/(H*.30),-1,1);}
      }
      interagir();
    });
    const soltar=e=>{
      if(!pts.has(e.pointerId))return;pts.delete(e.pointerId);if(pts.size<2)ultDist=0;
      canvas.style.cursor='grab';
      if(e.type==='pointerup'&&!moveu&&pts.size===0){const [x,y]=local(e);tocarEm(x,y);}
      interagir();
    };
    canvas.addEventListener('pointerup',soltar);canvas.addEventListener('pointercancel',soltar);
    canvas.addEventListener('wheel',e=>{                 // Ctrl/⌘+roda e pinça do touchpad; roda comum rola a página
      if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();const [x,y]=local(e);definirZoom(zoomAlvo*(e.deltaY<0?1.12:.89),x,y);
    },{passive:false});
    canvas.addEventListener('keydown',e=>{
      if(e.key==='+'||e.key==='='){definirZoom(zoomAlvo*1.25);e.preventDefault();}
      else if(e.key==='-'){definirZoom(zoomAlvo/1.25);e.preventDefault();}
      else if(e.key==='0'){definirZoom(1);tiltAX=tiltAY=0;e.preventDefault();}
    });
    // Ponto da tela → ponto da imagem (inverso da transformação aplicada no desenho).
    const paraImagem=(px,py,tx,ty,rot)=>{
      const dx=px-(W/2+panX+tx),dy=py-(H/2+panY+ty),c=Math.cos(-rot),s2=Math.sin(-rot);
      return[W/2+(dx*c-dy*s2)/zoom,H/2+(dx*s2+dy*c)/zoom];
    };
    function frame(ms){
      if(!ativo||fallback)return;raf=requestAnimationFrame(frame);
      const ativoToque=ms-inter<900;if(!ready||document.hidden||W<3||H<3||ms-last<(ativoToque||troca||estado==='falando'?14:quiet?180:26))return;
      last=ms;const t=quiet?0:ms/1000,p=PALETAS[estado]||PALETAS.idle;
      // com agente: repouso/fala = cor dele; ouvindo/raciocinando misturam com azul/violeta; executando segue verde
      const alvo=corAg?(estado==='executando'?p.cor:(estado==='idle'||estado==='falando')?corAg:corAg.map((v,i)=>v+(p.cor[i]-v)*.45)):p.cor;
      const claroAlvo=corAg&&estado!=='executando'?corAg.map(v=>Math.round(v+(255-v)*.72)):p.claro;
      cor=cor.map((v,i)=>v+(alvo[i]-v)*(quiet?1:.13));
      const pulse=quiet?0:Math.sin(t*(estado==='falando'?5.3:1.4)),breath=quiet?1:1+Math.sin(t*.95)*.0025;
      const h=H*.965*breath,w=h*iw/ih,scale=Math.min(1,W*.98/w),dw=w*scale,dh=h*scale;
      const x=(W-dw)/2,y=(H-dh)/2;
      ctx.clearRect(0,0,W,H);
      const halo=ctx.createRadialGradient(W*.5,H*.43,0,W*.5,H*.43,H*.52);
      halo.addColorStop(0,'rgba(16,95,138,.055)');halo.addColorStop(1,'rgba(0,50,90,0)');ctx.fillStyle=halo;ctx.fillRect(0,0,W,H);
      // suaviza zoom/arraste/inclinação; a mola devolve a inclinação ao centro quando você solta
      { const df=Math.min(6,Math.max(.25,(ms-(frame.ant||ms-16))/16.7));frame.ant=ms;       // suavização independente da taxa de quadros
        const k=quiet?1:1-Math.pow(.8,df),kt=quiet?1:1-Math.pow(.84,df);zoom+=(zoomAlvo-zoom)*k;panX+=(panAX-panX)*k;panY+=(panAY-panY)*k;
        if(!pts.size){const m=Math.pow(.9,df);tiltAX*=m;tiltAY*=m;}tiltX+=(tiltAX-tiltX)*kt;tiltY+=(tiltAY-tiltY)*kt;
        if(Math.abs(zoomAlvo-zoom)>.002||Math.abs(panAX-panX)>.3||Math.abs(panAY-panY)>.3||Math.abs(tiltAX-tiltX)>.003||Math.abs(tiltAY-tiltY)>.003||Math.abs(tiltAX)>.003)inter=ms; }
      { const dft=Math.min(6,Math.max(.25,(ms-(frame.ant2||ms-16))/16.7));frame.ant2=ms;
        tintA+=(tintAlvo-tintA)*(quiet?1:1-Math.pow(.88,dft));if(tintOld){tintOldA*=quiet?0:Math.pow(.88,dft);if(tintOldA<.02)tintOld=null;}
        if(Math.abs(tintAlvo-tintA)>.01||tintOld)inter=ms; }
      const tx=tiltX*W*.02,ty=tiltY*H*.012,rot=tiltX*.03;
      if(scene.width!==canvas.width){scene.width=canvas.width;scene.height=canvas.height;}
      sx.setTransform(dprAtual,0,0,dprAtual,0,0);sx.clearRect(0,0,W,H);
      sx.save();sx.translate(W/2+panX+tx,H/2+panY+ty);sx.rotate(rot);sx.scale(zoom,zoom);sx.translate(-W/2,-H/2);
      sx.drawImage(base,x,y,dw,dh);
      if(tintOld&&tintOldA>.02){sx.globalAlpha=tintOldA;sx.drawImage(tintOld,x,y,dw,dh);}
      if(tint&&tintA>.02){sx.globalAlpha=tintA;sx.drawImage(tint,x,y,dw,dh);}
      sx.globalAlpha=1;
      const e=energy.getContext('2d');e.clearRect(0,0,iw,ih);e.globalCompositeOperation='source-over';e.drawImage(mask,0,0);
      e.globalCompositeOperation='source-in';const flow=e.createLinearGradient(0,0,0,ih);
      for(let k=0;k<=8;k++){
        const a=quiet?.96:.86+.12*Math.sin(t*1.9-k*.70)+(estado==='ouvindo'?nivel*.09:estado==='falando'?pulse*.04:0);
        flow.addColorStop(k/8,`rgba(${cor.map(Math.round).join(',')},${limitar(a,.60,1)})`);
      }
      e.fillStyle=flow;e.fillRect(0,0,iw,ih);e.globalCompositeOperation='source-over';
      // energia correndo pelas veias: ondas que nascem na base do tronco e sobem até o rosto (como recarregando)
      const dtS=Math.min(.1,Math.max(0,(ms-(frame.ant4||ms))/1000));frame.ant4=ms;
      const velAlvo=quiet?0:estado==='executando'?.95:estado==='pensando'?.55:estado==='falando'?.36+envS*.25:estado==='ouvindo'?.28+nivel*.5:.17;
      velS+=(velAlvo-velS)*Math.min(1,dtS*3);fase+=velS*dtS;
      // luz do rosto: respira parado, pulsa na fala, vibra ao pensar, segue o microfone ao ouvir, pisca de tempos em tempos
      const pis=quiet?1:((t%5.3)<.15||(t%8.7)<.12)?.45:1;
      const luzAlvo=quiet?.5:estado==='falando'?.45+.55*envS+.1*Math.sin(t*13):estado==='pensando'?.55+.35*Math.sin(t*9)*Math.sin(t*4.3):estado==='ouvindo'?.35+nivel*.9:estado==='executando'?.7+.3*Math.sin(t*16):.32+.12*Math.sin(t*1.3);
      luzS+=(luzAlvo-luzS)*(quiet?1:Math.min(1,dtS*14));
      const luz=limitar(luzS*pis+Math.exp(-(ms-estadoT)/450)*.5,0,1.3);
      if(!quiet){
        const cl=claroAlvo.join(',');e.globalCompositeOperation='source-atop';
        for(let k=0;k<3;k++){const q=(fase+k/3)%1,R=q*ih*1.1,cxp=iw*.5,cyp=ih*.985,a=(1-q)*.9*(.6+luz*.5);
          const g2=e.createRadialGradient(cxp,cyp,Math.max(0,R-ih*.11),cxp,cyp,R+ih*.02);
          g2.addColorStop(0,`rgba(${cl},0)`);g2.addColorStop(.86,`rgba(${cl},${a})`);g2.addColorStop(1,`rgba(${cl},0)`);e.fillStyle=g2;e.fillRect(0,0,iw,ih);}
        e.globalCompositeOperation='source-over';
      }
      sx.translate(tiltX*dw*.010,tiltY*dh*.006);
      sx.globalCompositeOperation='screen';sx.globalAlpha=quiet?1:.86+Math.min(.14,luz*.16);sx.drawImage(energy,x,y,dw,dh);sx.globalAlpha=1;
      if(toque){const dt=ms-toque.t;
        if(dt>1100)toque=null;
        else{const q=paraImagem(toque.x,toque.y,tx,ty,rot),a=1-dt/1100;sx.save();sx.beginPath();sx.arc(q[0],q[1],dw*(.08+.34*(dt/1100)),0,TAU);sx.clip();sx.globalAlpha=.95*a;sx.drawImage(energy,x,y,dw,dh);sx.restore();}
      }
      if(!quiet){ // faíscas de energia subindo pelo corpo
        const cs=claroAlvo.join(',');sx.globalCompositeOperation='lighter';
        for(const pt of parts){pt.y-=dtS*pt.v*(.4+velS*2.4);if(pt.y<.16){pt.y=.97;pt.x=.5+(Math.random()-.5)*.55;}
          const al=pt.a*Math.min(1,(1-pt.y)*4)*Math.min(1,(pt.y-.15)*6)*(.35+luz*.65);
          sx.fillStyle=`rgba(${cs},${al})`;sx.beginPath();sx.arc(x+dw*(pt.x+Math.sin(t*1.5+pt.ph)*.012),y+dh*pt.y,pt.s*dw/650+.5,0,TAU);sx.fill();}
        sx.globalCompositeOperation='source-over';
      }
      // Projeção volumétrica suave, sempre centrada na cabeça da imagem.
      const cx=x+dw*.5,cy=y+dh*.255,rx=dw*(.060+(estado==='ouvindo'?nivel*.008:0))*(quiet?1:1+luz*.55),ry=dh*.080*(quiet?1:1+luz*.45);
      sx.save();sx.translate(cx,cy);sx.scale(rx,ry);
      const g=sx.createRadialGradient(0,0,0,0,0,1);
      g.addColorStop(0,`rgba(${claroAlvo.join(',')},${quiet?.075:.05+luz*.34})`);g.addColorStop(.35,`rgba(${claroAlvo.join(',')},${quiet?0:luz*.12})`);g.addColorStop(1,`rgba(${cor.map(Math.round).join(',')},0)`);
      sx.fillStyle=g;sx.beginPath();sx.arc(0,0,1,0,TAU);sx.fill();sx.restore();sx.globalCompositeOperation='source-over';
      sx.restore();                                                  // fim da transformação de zoom/inclinação
      // ---------- vida: movimento do tronco e da cabeça ----------
      { const wk=quiet?1:1-Math.pow(.9,Math.min(6,Math.max(.25,(ms-(frame.ant3||ms-16))/16.7)));frame.ant3=ms;
        for(const k in pesos)pesos[k]+=((k===estado?1:0)-pesos[k])*wk;
        const envAlvo=estado==='falando'?limitar(.55+.45*Math.sin(t*6.1)*Math.sin(t*2.3+1.2)+.2*Math.sin(t*11.7),0,1):estado==='ouvindo'?nivel:0;envS+=(envAlvo-envS)*(quiet?1:.18); }
      const pj=troca?(ms-troca.t)/1400:1;if(pj>=1)troca=null;
      const jolt=troca?Math.sin(Math.PI*Math.min(1,pj*1.6))*Math.max(0,1-pj)*1.4:0,kick=Math.exp(-(ms-estadoT)/450);
      const pw=pesos,env=envS;
      const M=quiet?{tx:0,ty:0,rot:0,sc:1,hr:0,hx:0,hy:0}:{
        tx:Math.sin(t*.43)*W*.004+jolt*Math.sin(t*38)*W*.004,
        ty:Math.sin(t*.95)*H*.003+env*Math.sin(t*6.1)*H*.002-jolt*H*.006,
        rot:Math.sin(t*.37)*.006+pw.pensando*Math.sin(t*.5)*.007,
        sc:1+Math.sin(t*.95)*.004+jolt*.035+pw.executando*Math.sin(t*9)*.004,
        hr:Math.sin(t*.61+1)*.022+Math.sin(t*.23)*.012+pw.pensando*(.05+.03*Math.sin(t*.4))+pw.ouvindo*(.035+.01*Math.sin(t*1.3))+pw.falando*env*.03*Math.sin(t*4.4)+jolt*.07*Math.sin(t*22)+kick*.03*Math.sin(t*14),
        hx:Math.sin(t*.5)*W*.010+Math.sin(t*.29+2)*W*.006+pw.pensando*Math.sin(t*.55)*W*.02+pw.ouvindo*W*.01+jolt*Math.sin(t*30)*W*.006,
        hy:Math.sin(t*.95+.4)*H*.002+pw.falando*(Math.sin(t*6.1)*.5+.5)*env*H*.010+pw.ouvindo*H*.012+pw.executando*Math.abs(Math.sin(t*5))*H*.006+kick*H*.008,
      };
      const fw=(px,py)=>{const cr=Math.cos(rot),sr=Math.sin(rot),qx=px-W/2,qy=py-H/2;return[W/2+panX+tx+(qx*cr-qy*sr)*zoom,H/2+panY+ty+(qx*sr+qy*cr)*zoom];};
      const nk=fw(x+dw*.5,y+dh*.56),y0n=fw(x+dw*.5,y+dh*.60)[1],y1n=fw(x+dw*.5,y+dh*.43)[1];   // pivô no pescoço; a flexão vai da base do pescoço ao queixo
      const pbx=W/2,pby=H*.985;
      ctx.save();ctx.translate(pbx+M.tx,pby+M.ty);ctx.rotate(M.rot);ctx.scale(M.sc,M.sc*(1+(M.sc-1)*.6));ctx.translate(-pbx,-pby);
      if(quiet){ctx.drawImage(scene,0,0,W,H);}
      else{
        // Sem emenda: o tronco fica parado e, daí para cima, cada faixa horizontal se desloca um pouco mais que a de baixo.
        // O pescoço entorta de forma contínua e a cabeça se move inteira, como uma pessoa de verdade.
        const yb=Math.max(2,Math.min(H,y0n));
        ctx.save();ctx.beginPath();ctx.rect(0,yb,W,H-yb);ctx.clip();ctx.drawImage(scene,0,0,W,H);ctx.restore();
        const passo=3,span=Math.max(8,y0n-y1n),d=dprAtual;
        for(let ya=0;ya<yb;ya+=passo){
          const yc=Math.min(yb,ya+passo),ym=(ya+yc)/2,u=limitar((y0n-ym)/span,0,1),w=u*u*(3-2*u);
          const dx=w*M.hx+Math.sin(M.hr)*(nk[1]-ym)*w,dy=w*M.hy,ov=yc<yb?1:0;
          ctx.drawImage(scene,0,ya*d,scene.width,(yc-ya+ov)*d,dx,ya+dy,W,yc-ya+ov);
        }
      }
      ctx.restore();
      if(troca){ // onda de energia + varredura na cor do novo agente
        const cc=troca.cor.map(Math.round).join(','),gx=geo?geo.cx:W/2,gy=geo?geo.cy:H*.3,gr=Math.max(40,dw*.30*zoom);
        ctx.save();ctx.globalCompositeOperation='screen';
        for(let k=0;k<2;k++){const q=limitar(pj*1.25-k*.18,0,1);if(q<=0||q>=1)continue;ctx.strokeStyle=`rgba(${cc},${(1-q)*.85})`;ctx.lineWidth=1+4*(1-q);ctx.beginPath();ctx.ellipse(gx,gy,gr*(.35+1.7*q),gr*(.35+1.7*q)*.92,0,0,TAU);ctx.stroke();}
        const by=H*(1.02-pj*1.15);
        ctx.save();ctx.translate(W/2,by);ctx.scale(W*.5,H*.10);const gb=ctx.createRadialGradient(0,0,0,0,0,1);gb.addColorStop(0,`rgba(${cc},${.55*(1-pj)})`);gb.addColorStop(1,`rgba(${cc},0)`);ctx.fillStyle=gb;ctx.beginPath();ctx.arc(0,0,1,0,TAU);ctx.fill();ctx.restore();
        const gl=ctx.createRadialGradient(gx,gy,0,gx,gy,gr*1.05);gl.addColorStop(0,`rgba(${cc},${.38*Math.max(0,1-pj*1.6)})`);gl.addColorStop(1,`rgba(${cc},0)`);ctx.fillStyle=gl;ctx.beginPath();ctx.arc(gx,gy,gr*1.05,0,TAU);ctx.fill();
        ctx.restore();inter=ms;
      }
      { // centro da cabeça já com zoom/arraste/inclinação (para o anel e as linhas ao redor)
        const hx=cx-W/2,hy=cy-H/2,cr=Math.cos(rot),sr=Math.sin(rot);
        geo={cx:W/2+panX+tx+(hx*cr-hy*sr)*zoom,cy:H/2+panY+ty+(hx*sr+hy*cr)*zoom,r:dw*.30*zoom,zoom:zoomAlvo,w:W,h:H,nivel:nivelAtual,cor:cor.map(Math.round)};
      }
      if(toque){const pr=(ms-toque.t)/1100;if(pr<1){ctx.save();ctx.globalCompositeOperation='screen';ctx.strokeStyle=`rgba(${cor.map(Math.round).join(',')},${(1-pr)*.75})`;ctx.lineWidth=.6+2.4*(1-pr);ctx.beginPath();ctx.arc(toque.x,toque.y,10+pr*80,0,TAU);ctx.stroke();ctx.restore();}}
      canvas.dataset.renderer='cinematografico';canvas.dataset.rendered='true';canvas.dataset.estado=estado;
    }
    raf=requestAnimationFrame(frame);
    return{
      setEstado(e){const n=PALETAS[e]?e:'idle';if(n!==estado)estadoT=performance.now();estado=n;if(fallback)fallback.setEstado(estado);last=-Infinity;delete canvas.dataset.rendered;},
      setCor(h){
        const n=parseInt(String(h).replace('#',''),16);
        if(Number.isFinite(n)){
          const nova=[(n>>16)&255,(n>>8)&255,n&255],ant=corAg||[53,184,255];
          if(!corIni&&!quiet&&nova.some((v,i)=>Math.abs(v-ant[i])>8))troca={t:performance.now(),cor:nova};
          corIni=false;
          if(String(h).toLowerCase()===COR_NORMAL){corAg=null;tintAlvo=0;}      // agente padrão: Jarvis de referência
          else{corAg=[(n>>16)&255,(n>>8)&255,n&255];tintAlvo=.78;prepararTint();}
          last=-Infinity;
        }
        if(fallback)fallback.setCor(h);
      },
      get corAgente(){return corAg;},
      setNivel(n){nivel=limitar(n||0,0,1);nivelAtual=nivel;if(fallback)fallback.setNivel(nivel);},
      zoomEm(z){definirZoom(z);},                         // 1 a 2,6
      resetar(){definirZoom(1);tiltAX=tiltAY=0;interagir();},
      get zoom(){return zoomAlvo;},
      geom(){return geo;},                                // {cx,cy,r,zoom,w,h,nivel,cor} em px do canvas
      aoToque(fn){cbToque=fn;},
      destroy(){ativo=false;cancelAnimationFrame(raf);observer.disconnect();img.onload=img.onerror=null;if(fallback)fallback.destroy();},
    };
  }

  // `principal` = a instância do avatar da tela (a órbita ao redor usa para medir e ampliar).
  window.JarvisAvatar={criar(canvas){const a=criar(canvas);if(canvas.id==='avatar')window.JarvisAvatar.principal=a;return a;}};
})();
