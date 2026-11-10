// Avatar: busto de linhas, anéis de HUD, varredura, partículas e núcleo.
// Canvas 2D puro. A cor acompanha o agente (com onda de choque na troca) e o
// movimento acompanha o estado:
//   idle      respira; partículas à deriva
//   ouvindo   partículas são sugadas para o núcleo; anel reage ao seu microfone
//   pensando  pontos em órbita e anéis acelerados
//   falando   partículas saem do núcleo; anel pulsa com a fala
// Nada aqui depende de biblioteca. Quem pede menos movimento vê quase parado.
(function () {
  const AMPL = { idle: 0.0018, ouvindo: 0.0042, pensando: 0.0030, falando: 0.0075 };
  const TAU = Math.PI * 2;

  const hex = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const sstep = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  // Meia-largura da silhueta (em "unidades de altura") na altura y (0 topo, 1 base).
  function meiaLargura(y) {
    const dy = (y - 0.27) / 0.21;
    if (Math.abs(dy) <= 1) return 0.165 * Math.sqrt(1 - dy * dy);   // cabeça
    if (y < 0.6) return y > 0.27 ? 0.055 : 0;                        // pescoço
    return 0.055 + 0.43 * sstep((y - 0.58) / 0.26);                  // ombros
  }

  function criar(canvas) {
    const ctx = canvas.getContext("2d");
    const reduzido = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const leve = Math.min(innerWidth, screen.width || innerWidth) < 700;      // celular: menos linhas/partículas
    const NLINHAS = leve ? 62 : 96, NPART = leve ? 110 : 240;

    let W = 0, H = 0, dpr = 1;
    let estado = "idle", corAtual = hex("#35b8ff"), corAlvo = corAtual;
    let amp = AMPL.idle, nivelFala = 0, nivelMic = 0;
    let px = 0, py = 0, alvoPx = 0, alvoPy = 0;       // paralaxe do ponteiro
    const ondas = [];                                  // ondas de choque (troca de agente)
    const T0 = performance.now();
    let ultimo = T0;

    const parts = [];
    const nova = (inicial) => ({
      a: Math.random() * TAU, r: 0.17 + Math.random() * 0.2, v: inicial ? Math.random() : 0,
      s: 0.6 + Math.random() * 1.5, w: (Math.random() - 0.5) * 0.002,
    });
    for (let i = 0; i < NPART; i++) parts.push(nova(true));

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, leve ? 1.5 : 2);
      const r = canvas.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(canvas);
    else window.addEventListener("resize", resize);
    resize();
    if (!reduzido) window.addEventListener("pointermove", (e) => {
      alvoPx = e.clientX / innerWidth - 0.5; alvoPy = e.clientY / innerHeight - 0.5;
    }, { passive: true });

    function frame(now) {
      const dt = Math.min(50, now - ultimo) / 16.7; ultimo = now;
      const t = ((now - T0) / 1000) * (reduzido ? 0.15 : 1);
      const rev = reduzido ? 1 : Math.min(1, (now - T0) / 1900);          // materializa na abertura

      // suavizações
      for (let i = 0; i < 3; i++) corAtual[i] += (corAlvo[i] - corAtual[i]) * 0.07;
      px += (alvoPx - px) * 0.04; py += (alvoPy - py) * 0.04;
      amp += (((AMPL[estado] || AMPL.idle) + (estado === "ouvindo" ? nivelMic * 0.006 : 0)) - amp) * 0.12;
      const alvoNivel = estado === "falando" ? 0.5 + 0.5 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.1))
                      : estado === "ouvindo" ? nivelMic : 0;
      nivelFala += (alvoNivel - nivelFala) * 0.16;

      ctx.clearRect(0, 0, W, H);
      const s = Math.min(H * 0.92, W * 1.6);
      const ox = W / 2 + px * s * 0.035, oy = (H - s) / 2 + py * s * 0.02;
      const cx = ox, cy = oy + 0.27 * s;
      const [r, g, b] = corAtual.map(Math.round);
      const claro = `${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)}`;
      const acel = estado === "pensando" ? 2.6 : estado === "falando" ? 1.5 : 1;

      ctx.globalCompositeOperation = "lighter";

      // anéis de HUD (arcos tracejados girando em sentidos opostos)
      ctx.lineWidth = 1;
      [[0.31, 0.32, 3], [0.38, -0.22, 2], [0.46, 0.15, 4]].forEach(([raio, vel, n], i) => {
        const rr = raio * s * (1 + 0.012 * Math.sin(t * 1.2 + i));
        const ang0 = t * vel * acel;
        ctx.setLineDash([s * 0.012, s * 0.009]);
        ctx.strokeStyle = `rgba(${r},${g},${b},${(0.10 + 0.05 * i + (estado === "pensando" ? 0.12 : 0)) * rev})`;
        for (let k = 0; k < n; k++) {
          const a0 = ang0 + (k * TAU) / n;
          ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a0 + (TAU / n) * 0.62); ctx.stroke();
        }
      });
      ctx.setLineDash([]);

      // corpo: linhas horizontais deslocadas, com leve giro e varredura luminosa
      const varre = 0.05 + ((t * 0.3) % 1) * 0.95;
      const giro = Math.sin(t * 0.25) * 0.02 + px * 0.06;
      for (let k = 0; k < NLINHAS; k++) {
        const y = 0.05 + (k / (NLINHAS - 1)) * 0.95;
        if (y > rev * 1.02) break;
        const w = meiaLargura(y);
        if (w <= 0.002) continue;
        const passos = Math.max(6, Math.round(w * 90));
        const brilho = Math.max(0, 1 - Math.abs(y - varre) / 0.035);
        ctx.beginPath();
        for (let i = 0; i <= passos; i++) {
          const u = -w + (2 * w * i) / passos;
          const off = amp * Math.sin(u * 22 + t * 1.6 + y * 38) * (0.6 + 0.4 * Math.sin(t * 0.7 + y * 9));
          const xx = ox + (u + giro * (y - 0.3)) * s, yy = oy + (y + off) * s;
          i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
        }
        const fade = (0.26 + 0.32 * Math.sin((k / NLINHAS) * Math.PI)) * Math.min(1, (rev - y) * 6 + 0.3);
        ctx.strokeStyle = brilho > 0 ? `rgba(${claro},${Math.min(1, fade + brilho * 0.6)})` : `rgba(${r},${g},${b},${fade})`;
        ctx.lineWidth = 1 + brilho * 1.2;
        ctx.stroke();
        ctx.fillStyle = `rgba(${claro},0.95)`;
        for (const sg of [-1, 1]) ctx.fillRect(ox + (sg * w + giro * (y - 0.3)) * s - 1, oy + y * s - 1, 2.2, 2.2);
      }
      ctx.lineWidth = 1;

      // "nervos" laranja
      for (let i = 0; i < 9; i++) {
        const base = (i - 4) / 4;
        ctx.beginPath();
        for (let j = 0; j <= 16; j++) {
          const yy = 0.5 + (j / 16) * 0.3;
          const xx = base * (0.02 + (yy - 0.5) * 0.35) + Math.sin(yy * 20 + i + t * 0.8) * 0.006;
          j ? ctx.lineTo(ox + xx * s, oy + yy * s) : ctx.moveTo(ox + xx * s, oy + yy * s);
        }
        ctx.strokeStyle = `rgba(255,170,60,${(0.16 + 0.18 * Math.sin(t * 1.3 + i)) * rev})`;
        ctx.stroke();
      }

      // anel de áudio ao redor da cabeça (reage ao microfone ou à fala)
      {
        const N = 72, base = 0.262 * s;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * TAU;
          const d = nivelFala * 0.04 * s * (0.45 + 0.55 * Math.sin(a * 7 + t * 9) * Math.sin(a * 3 - t * 4));
          const rr = base + d + Math.sin(a * 2 + t) * 0.002 * s;
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 1.12;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.strokeStyle = `rgba(${claro},${(0.16 + nivelFala * 0.6) * rev})`;
        ctx.lineWidth = 1 + nivelFala * 1.6; ctx.stroke(); ctx.lineWidth = 1;
      }

      // partículas: o comportamento depende do estado
      for (const p of parts) {
        p.v += 0.0035 * dt;
        if (estado === "ouvindo") { p.r -= (0.0013 + nivelMic * 0.003) * dt; p.a += p.w * 3 * dt; }
        else if (estado === "falando") { p.r += (0.0009 + nivelFala * 0.003) * dt; p.a += p.w * dt; }
        else if (estado === "pensando") { p.a += (0.012 + p.w * 4) * dt; p.r += (0.30 - p.r) * 0.01 * dt; }
        else { p.r += 0.00018 * dt; p.a += p.w * dt; }
        if (p.r > 0.44 || p.r < 0.07 || p.v > 1) {
          Object.assign(p, nova(false));
          p.r = estado === "ouvindo" ? 0.36 + Math.random() * 0.08 : estado === "falando" ? 0.1 + Math.random() * 0.06 : 0.17 + Math.random() * 0.2;
        }
        const al = Math.sin(Math.min(1, p.v) * Math.PI) * (estado === "idle" ? 0.55 : 0.85) * rev;
        ctx.fillStyle = `rgba(${r},${g},${b},${al})`;
        ctx.fillRect(cx + Math.cos(p.a) * p.r * s, cy + Math.sin(p.a) * p.r * s * 1.1, p.s, p.s);
      }

      // pensando: pontos em órbita
      if (estado === "pensando") {
        for (let i = 0; i < 5; i++) {
          const a = t * 2.4 + (i * TAU) / 5;
          ctx.fillStyle = `rgba(${claro},0.9)`;
          ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 0.30 * s, cy + Math.sin(a) * 0.30 * s * 1.1, 2.6, 0, TAU); ctx.fill();
        }
      }

      // núcleo
      const pulso = 1 + 0.08 * Math.sin(t * 2.2) + nivelFala * 0.4 + (estado === "pensando" ? 0.12 * Math.sin(t * 9) : 0);
      const rc = 0.13 * s * pulso * (0.4 + 0.6 * rev);
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rc);
      gr.addColorStop(0, "rgba(255,250,235,0.95)"); gr.addColorStop(0.25, "rgba(255,190,90,0.75)");
      gr.addColorStop(0.7, "rgba(255,110,20,0.22)"); gr.addColorStop(1, "rgba(255,90,0,0)");
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, rc, 0, TAU); ctx.fill();

      // ondas de choque (troca de agente)
      for (let i = ondas.length - 1; i >= 0; i--) {
        const p = (now - ondas[i]) / 1300;
        if (p >= 1) { ondas.splice(i, 1); continue; }
        ctx.strokeStyle = `rgba(${claro},${(1 - p) * 0.7})`; ctx.lineWidth = 1 + (1 - p) * 4;
        ctx.beginPath(); ctx.arc(cx, cy, (0.05 + p * 0.62) * s, 0, TAU); ctx.stroke();
      }
      ctx.lineWidth = 1;

      ctx.globalCompositeOperation = "source-over";
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
      setCor(h) {
        const n = hex(h);
        if (n[0] !== corAlvo[0] || n[1] !== corAlvo[1] || n[2] !== corAlvo[2]) { corAlvo = n; if (!reduzido) ondas.push(performance.now()); }
      },
      setEstado(e) { estado = AMPL[e] != null ? e : "idle"; },
      setNivel(n) { nivelMic = Math.max(0, Math.min(1, n || 0)); },
    };
  }

  window.JarvisAvatar = { criar };
})();
