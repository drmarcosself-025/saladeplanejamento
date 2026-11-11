// Busto holográfico: malha volumétrica azul, partículas e núcleo âmbar.
// Canvas nativo, decorativo. O estado acompanha a voz; não representa biometria.
(function () {
  const TAU = Math.PI * 2;
  function criar(canvas) {
    const ctx = canvas.getContext('2d');
    const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mobile = innerWidth < 700;
    let W = 1, H = 1, estado = 'idle', nivel = 0, last = -Infinity;
    let tint = [55, 211, 255], target = tint.slice();
    const resize = () => {
      const box = canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2);
      W = Math.max(1, box.width); H = Math.max(1, box.height);
      canvas.width = W * d; canvas.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0);
      last = -Infinity; delete canvas.dataset.rendered;
    };
    new ResizeObserver(resize).observe(canvas); resize();
    const smooth = n => { n = Math.max(0, Math.min(1, n)); return n * n * (3 - 2 * n); };
    const rand = i => { const v = Math.sin(i * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
    const widthAt = y => {
      if (y < 1.23) {
        const k = (y - .59) / .63;
        return Math.max(.015, .47 * Math.sqrt(Math.max(0, 1 - k * k)) * (y > .94 ? 1 - (y - .94) * .65 : 1));
      }
      if (y < 1.60) return .125 + (1.60 - y) * .035;
      return .135 + .86 * smooth((y - 1.60) / .61);
    };
    const surface = (u, y, back = false) => {
      const x = u * widthAt(y), curve = Math.sqrt(Math.max(0, 1 - u * u));
      let z = curve * (y < 1.23 ? .26 : y < 1.60 ? .13 : .19);
      if (y < 1.23) z += .065 * Math.exp(-Math.pow(x / .08, 2) - Math.pow((y - .74) / .21, 2));
      return [x, y, back ? -z : z];
    };
    function frame(ms) {
      requestAnimationFrame(frame);
      if (document.hidden || W < 3 || H < 3 || ms - last < (quiet ? 180 : 32)) return;
      last = ms;
      const t = quiet ? 0 : ms / 1000, s = Math.min(H / 2.47, W / 2.20), cx = W * .5, oy = H * .025;
      const breath = quiet ? 0 : Math.sin(t * 1.15) * .006;
      const yaw = .10 + (quiet ? 0 : Math.sin(t * .21) * .06);
      const project = ([x, y, z]) => [cx + (x * Math.cos(yaw) + z * Math.sin(yaw)) * s, oy + (y - z * .13 + breath) * s];
      tint = tint.map((v, i) => v + (target[i] - v) * .05);
      const rgb = tint.map(Math.round).join(',');
      const line = (pts, alpha, width = .7, glow = 0) => {
        ctx.strokeStyle = `rgba(${rgb},${alpha})`; ctx.lineWidth = width; ctx.shadowBlur = glow; ctx.shadowColor = `rgba(${rgb},.9)`;
        ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = project(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.shadowBlur = 0;
      };
      ctx.clearRect(0, 0, W, H);
      const core = project([0, .77, .30]);
      const power = estado === 'ouvindo' ? .8 + nivel * .28 : estado === 'falando' ? 1 + Math.sin(t * 6) * .08 : estado === 'pensando' ? 1.07 : .88 + Math.sin(t * 1.7) * .04;
      // A luz parte do centro, sob as linhas do holograma.
      const ambient = ctx.createRadialGradient(core[0], core[1], 0, core[0], core[1], s * .85);
      ambient.addColorStop(0, `rgba(29,165,235,${.14 * power})`); ambient.addColorStop(.55, 'rgba(17,109,184,.045)'); ambient.addColorStop(1, 'rgba(0,70,140,0)');
      ctx.fillStyle = ambient; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      const warm = ctx.createRadialGradient(core[0], core[1], 0, core[0], core[1], s * .37 * power);
      warm.addColorStop(0, 'rgba(255,249,197,.97)'); warm.addColorStop(.055, 'rgba(255,232,125,.95)');
      warm.addColorStop(.20, 'rgba(255,185,54,.78)'); warm.addColorStop(.46, 'rgba(255,112,24,.35)'); warm.addColorStop(.78, 'rgba(227,72,17,.07)'); warm.addColorStop(1, 'rgba(255,98,0,0)');
      ctx.fillStyle = warm; ctx.beginPath(); ctx.arc(core[0], core[1], s * .38 * power, 0, TAU); ctx.fill();
      // Linhas horizontais com profundidade e contornos iluminados.
      const rows = mobile ? 73 : 101;
      for (let j = 1; j < rows; j++) {
        const y = j / rows * 2.29;
        const front = Array.from({length: 43}, (_, k) => surface(k / 21 - 1, y));
        const back = Array.from({length: 31}, (_, k) => surface(k / 15 - 1, y, true));
        line(back, y < 1.23 ? .07 : .035, .5);
        line(front, y < 1.23 ? .42 : y < 1.60 ? .36 : .22 - (y - 1.60) * .12, .65);
      }
      // Meridianos: relevo da cabeça, linhas do pescoço e volume dos ombros.
      for (let k = 1; k < (mobile ? 19 : 27); k++) {
        const u = k / (mobile ? 19 : 27) * 2 - 1;
        line(Array.from({length: 65}, (_, j) => surface(u, .025 + j / 64 * 2.26)), .11 + Math.abs(u) * .06, .55);
      }
      // Dois contornos contínuos destacam a silhueta do busto.
      for (const side of [-1, 1]) {
        const edge = Array.from({length: 113}, (_, j) => { const y = .025 + j / 112 * 2.25; return surface(side, y); });
        line(edge, .23, 3.2, 15); line(edge, .80, 1.2, 6);
      }
      // Partículas ao redor da cabeça e dos ombros, com movimento suave.
      const count = mobile ? 155 : 260;
      for (let i = 0; i < count; i++) {
        const y = rand(i + 3) * 1.85 - .12, a = rand(i + 501) * TAU;
        const w = widthAt(Math.max(.025, y)) + .025 + rand(i + 805) * .14;
        const drift = quiet ? 0 : Math.sin(t * .45 + i) * .013;
        const p = project([Math.cos(a) * w + drift, y + drift, Math.sin(a) * .23]);
        const alpha = .12 + rand(i + 91) * .47;
        ctx.fillStyle = `rgba(${rgb},${alpha})`; const size = .5 + rand(i + 45) * 1.05;
        ctx.fillRect(p[0], p[1], size, size);
      }
      // Fios de luz ligam o pescoço ao núcleo.
      for (let k = 0; k < 7; k++) {
        const x = (k - 3) * .03;
        const pts = Array.from({length: 30}, (_, j) => { const f = j / 29; return [x * (1.4 - f), 1.84 - f * .68, .14 + f * .07]; });
        line(pts, .16, .7, 3);
      }
      // Núcleo e halo da voz, sem números fictícios.
      ctx.fillStyle = 'rgba(255,249,208,.85)'; ctx.shadowColor = '#ffc66b'; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(core[0], core[1], s * .019 * power, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = 'source-over'; canvas.dataset.rendered = 'true';
    }
    requestAnimationFrame(frame);
    return {
      setEstado(e) { estado = e; },
      setCor(h) { const n = parseInt(String(h).replace('#', ''), 16); if (Number.isFinite(n)) target = [55 + ((n >> 16) & 255) * .04, 204 + ((n >> 8) & 255) * .035, 250]; },
      setNivel(n) { nivel = Math.max(0, Math.min(1, n || 0)); },
    };
  }
  window.JarvisAvatar = { criar };
})();
