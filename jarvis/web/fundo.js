// Fundo animado: grade em perspectiva e poeira, na cor do agente ativo.
// Atrás de tudo, bem discreto (opacidade baixa), a ~30 quadros por segundo.
(function () {
  function criar(canvas) {
    const ctx = canvas.getContext("2d");
    const reduzido = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const leve = Math.min(innerWidth, screen.width || innerWidth) < 700;
    let W = 0, H = 0, cor = [53, 184, 255], alvo = cor, px = 0, alvoPx = 0, ultimo = 0;
    const poeira = Array.from({ length: leve ? 28 : 60 }, () => ({ x: Math.random(), y: Math.random(), v: 0.00005 + Math.random() * 0.00012, s: 0.5 + Math.random() * 1.2 }));
    const hex = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

    function resize() {
      const d = Math.min(devicePixelRatio || 1, 1.5);
      W = innerWidth; H = innerHeight; canvas.width = W * d; canvas.height = H * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      if (reduzido) quadro(performance.now());
    }
    window.addEventListener("resize", resize);
    if (!reduzido) window.addEventListener("pointermove", (e) => { alvoPx = e.clientX / innerWidth - 0.5; }, { passive: true });

    function quadro(now) {
      for (let i = 0; i < 3; i++) cor[i] += (alvo[i] - cor[i]) * 0.06;
      px += (alvoPx - px) * 0.05;
      const [r, g, b] = cor.map(Math.round), t = now / 1000;
      ctx.clearRect(0, 0, W, H);
      const hz = H * 0.52, vx = W / 2 + px * W * 0.08;      // horizonte e ponto de fuga

      // linhas horizontais do "chão", aproximando-se
      ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const f = ((i + (reduzido ? 0 : t * 0.35)) % 14) / 14;           // 0 (longe) → 1 (perto)
        const y = hz + Math.pow(f, 2.2) * (H - hz);
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.02 + f * 0.07})`;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      // linhas que convergem ao ponto de fuga
      for (let i = -9; i <= 9; i++) {
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.025 + 0.04 * (1 - Math.abs(i) / 9)})`;
        ctx.beginPath(); ctx.moveTo(vx, hz); ctx.lineTo(vx + i * W * 0.14, H); ctx.stroke();
      }
      // poeira subindo
      for (const p of poeira) {
        if (!reduzido) { p.y -= p.v * 16; if (p.y < 0) { p.y = 1; p.x = Math.random(); } }
        ctx.fillStyle = `rgba(${r},${g},${b},${0.10 + 0.25 * Math.abs(Math.sin(t * 0.6 + p.x * 9))})`;
        ctx.fillRect(p.x * W, p.y * H, p.s, p.s);
      }
    }
    function laco(now) {
      if (now - ultimo > 33) { ultimo = now; quadro(now); }
      requestAnimationFrame(laco);
    }
    resize();
    if (!reduzido) requestAnimationFrame(laco);
    return { setCor(h) { alvo = hex(h); if (reduzido) { cor = alvo.slice(); quadro(performance.now()); } } };
  }
  window.JarvisFundo = { criar };
})();
