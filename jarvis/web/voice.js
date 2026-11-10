// Voz: entrada (SpeechRecognition) e saída (speechSynthesis), 100% no
// navegador. Sem custo e sem enviar áudio a servidor nosso. Limites:
//  - reconhecimento funciona bem no Chrome/Edge; exige HTTPS ou localhost;
//  - a qualidade da voz depende das vozes pt-BR instaladas no sistema.
// Uma troca futura para Whisper/Realtime API só substitui este arquivo.
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, ouvindo = false, onTexto = () => {}, onEstado = () => {}, onErro = () => {};
  let mudo = false, voz = null;

  function escolherVoz() {
    const vs = speechSynthesis.getVoices();
    voz = vs.find((v) => /pt-BR/i.test(v.lang) && /google|luciana|francisca|microsoft/i.test(v.name))
       || vs.find((v) => /pt-BR/i.test(v.lang)) || vs.find((v) => /^pt/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) {
    escolherVoz();
    speechSynthesis.onvoiceschanged = escolherVoz;
  }

  function iniciarReconhecimento() {
    if (!SR) { onErro("Este navegador não tem reconhecimento de voz. Use Chrome ou Edge, ou digite."); return false; }
    rec = new SR();
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) onTexto(e.results[i][0].transcript.trim());
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        ouvindo = false; onEstado(false);
        onErro("Permissão do microfone negada. Libere o microfone no navegador (e use HTTPS ou localhost).");
      }
    };
    // O Chrome encerra a escuta sozinho de tempos em tempos: reinicia enquanto ligado.
    rec.onend = () => { if (ouvindo) { try { rec.start(); } catch (_) {} } };
    try { rec.start(); } catch (_) {}
    return true;
  }

  window.JarvisVoice = {
    suportaEntrada: !!SR,
    suportaSaida: "speechSynthesis" in window,
    configurar(cb) { onTexto = cb.onTexto || onTexto; onEstado = cb.onEstado || onEstado; onErro = cb.onErro || onErro; },
    alternarEscuta() {
      if (ouvindo) { ouvindo = false; try { rec.stop(); } catch (_) {} onEstado(false); return false; }
      if (iniciarReconhecimento()) { ouvindo = true; onEstado(true); return true; }
      return false;
    },
    get escutando() { return ouvindo; },
    get mudo() { return mudo; },
    set mudo(v) { mudo = !!v; if (mudo) speechSynthesis.cancel(); },
    // Fala e resolve quando terminar. Sem voz/mudo: resolve após um tempo
    // proporcional ao texto, para a animação e a legenda ficarem coerentes.
    falar(texto) {
      return new Promise((resolve) => {
        const tempoLeitura = Math.min(14000, 1200 + texto.length * 55);
        if (mudo || !this.suportaSaida) return setTimeout(resolve, tempoLeitura);
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = "pt-BR"; if (voz) u.voice = voz; u.rate = 1.05;
        let fim = false;
        const done = () => { if (!fim) { fim = true; resolve(); } };
        u.onend = done; u.onerror = done;
        setTimeout(done, tempoLeitura + 6000);          // rede de segurança
        speechSynthesis.speak(u);
      });
    },
    parar() { if (this.suportaSaida) speechSynthesis.cancel(); },
  };
})();
