// Avatar: busto feito de linhas horizontais deslocadas + partículas + núcleo.
// Canvas 2D puro, sem biblioteca. A cor acompanha o modo (transição suave) e
// a amplitude acompanha o estado (idle / ouvindo / pensando / falando).
(function () {
  const AMPL = { idle: 0.0018, ouvindo: 0.0042, pensando: 0.0030, falando: 0.0075 };

  function hex(h) {
    const n = parseInt(h.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
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
    let W = 0, H = 0, dpr = 1;
    let estado = "idle";
    let corAtual = hex("#35b8ff"), corAlvo = corAtual;
    let amp = AMPL.idle, nivelFala = 0;
    const parts = [];
    for (let i = 0; i < 220; i++) parts.push(novaParticula(true));

    function novaParticula(inicial) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.16 + Math.random() * 0.12;
      return {
        x: Math.cos(a) * r, y: 0.27 + Math.sin(a) * r * 1.25,
        vx: (Math.random() - 0.3) * 0.0004, vy: -Math.random() * 0.0005,
        v: inicial ? Math.random() : 0, s: 0.6 + Math.random() * 1.4,
      };
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener("resize", resize);
    resize();

    let t0 = performance.now();
    function frame(now) {
      const t = (now - t0) / 1000;
      // transição de cor e amplitude
      for (let i = 0; i < 3; i++) corAtual[i] += (corAlvo[i] - corAtual[i]) * 0.06;
      const alvoAmp = AMPL[estado] || AMPL.idle;
      amp += (alvoAmp - amp) * 0.08;
      nivelFala += ((estado === "falando" ? 0.5 + 0.5 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.1)) : 0) - nivelFala) * 0.15;

      ctx.clearRect(0, 0, W, H);
      const s = Math.min(H * 0.92, W * 1.6);       // escala: altura total da figura
      const ox = W / 2, oy = (H - s) / 2;
      const [r, g, b] = corAtual.map(Math.round);

      ctx.globalCompositeOperation = "lighter";

      // linhas do corpo
      const N = 96;
      for (let k = 0; k < N; k++) {
        const y = 0.05 + (k / (N - 1)) * 0.95;
        const w = meiaLargura(y);
        if (w <= 0.002) continue;
        const passos = Math.max(6, Math.round(w * 90));
        ctx.beginPath();
        for (let i = 0; i <= passos; i++) {
          const u = -w + (2 * w * i) / passos;
          const off = amp * Math.sin(u * 22 + t * 1.6 + y * 38) * (0.6 + 0.4 * Math.sin(t * 0.7 + y * 9));
          const px = ox + u * s, py = oy + (y + off) * s;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        const fade = 0.28 + 0.34 * Math.sin((k / N) * Math.PI);
        ctx.strokeStyle = `rgba(${r},${g},${b},${fade})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        // pontos brilhantes nas bordas = contorno luminoso
        ctx.fillStyle = `rgba(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)},0.95)`;
        for (const sg of [-1, 1]) ctx.fillRect(ox + sg * w * s - 1, oy + y * s - 1, 2.2, 2.2);
      }

      // "nervos" laranja no pescoço e peito
      ctx.lineWidth = 1;
      for (let i = 0; i < 9; i++) {
        const base = (i - 4) / 4;
        ctx.beginPath();
        for (let j = 0; j <= 16; j++) {
          const yy = 0.5 + (j / 16) * 0.3;
          const xx = base * (0.02 + (yy - 0.5) * 0.35) + Math.sin(yy * 20 + i + t * 0.8) * 0.006;
          const px = ox + xx * s, py = oy + yy * s;
          j ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.strokeStyle = `rgba(255,170,60,${0.18 + 0.18 * Math.sin(t * 1.3 + i)})`;
        ctx.stroke();
      }

      // partículas ao redor da cabeça
      for (const p of parts) {
        p.x += p.vx + Math.sin(t + p.y * 9) * 0.00015; p.y += p.vy; p.v += 0.004;
        if (p.v > 1) Object.assign(p, novaParticula(false));
        const a = Math.sin(Math.min(1, p.v) * Math.PI) * 0.7;
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.fillRect(ox + p.x * s, oy + p.y * s, p.s, p.s);
      }

      // núcleo
      const pulso = 1 + 0.08 * Math.sin(t * 2.2) + nivelFala * 0.35 + (estado === "pensando" ? 0.12 * Math.sin(t * 9) : 0);
      const rc = 0.13 * s * pulso;
      const cx = ox, cy = oy + 0.27 * s;
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rc);
      gr.addColorStop(0, "rgba(255,250,235,0.95)");
      gr.addColorStop(0.25, "rgba(255,190,90,0.75)");
      gr.addColorStop(0.7, "rgba(255,110,20,0.22)");
      gr.addColorStop(1, "rgba(255,90,0,0)");
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(cx, cy, rc, 0, Math.PI * 2); ctx.fill();

      ctx.globalCompositeOperation = "source-over";
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
      setCor(h) { corAlvo = hex(h); },
      setEstado(e) { estado = AMPL[e] != null ? e : "idle"; },
    };
  }

  window.JarvisAvatar = { criar };
})();
