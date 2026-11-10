// Sons de interface: bipes curtos e baixos, sintetizados (sem arquivo de áudio).
// Seguem o botão de silenciar. O navegador só libera som depois de um clique/toque.
(function () {
  let ac = null, mudo = false;
  const NOTAS = {
    ativar:    [[520, 0, 0.07], [784, 0.07, 0.12]],
    ouvir:     [[660, 0, 0.06]],
    enviar:    [[440, 0, 0.05], [660, 0.05, 0.08]],
    confirmar: [[523, 0, 0.06], [659, 0.06, 0.06], [784, 0.12, 0.14]],
    erro:      [[220, 0, 0.12], [175, 0.12, 0.16]],
    fim:       [[784, 0, 0.05], [523, 0.05, 0.1]],
  };
  function contexto() {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; } }
    if (ac.state === "suspended") ac.resume().catch(() => {});
    return ac;
  }
  window.JarvisSfx = {
    get mudo() { return mudo; },
    set mudo(v) { mudo = !!v; },
    tocar(nome) {
      if (mudo || !NOTAS[nome]) return;
      const a = contexto(); if (!a) return;
      const t0 = a.currentTime;
      for (const [f, ini, dur] of NOTAS[nome]) {
        const o = a.createOscillator(), g = a.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + ini);
        g.gain.exponentialRampToValueAtTime(0.045, t0 + ini + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + ini + dur + 0.05);
        o.connect(g).connect(a.destination); o.start(t0 + ini); o.stop(t0 + ini + dur + 0.08);
      }
    },
  };
})();
