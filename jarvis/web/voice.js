// Voz: entrada (SpeechRecognition) e saída (speechSynthesis), no navegador.
//
// PRIVACIDADE: no Chrome/Edge o reconhecimento de fala é feito pelo servidor
// do próprio navegador (o áudio vai ao Google/Microsoft). Não passa por
// nenhum servidor nosso, mas SAI do seu computador. A interface avisa isso.
// A saída (a voz do Jarvis) é local, do sistema operacional.
//
// Dois modos de entrada:
//  - contínuo: microfone ligado, só age quando ouvir "Jarvis" (ou logo após uma
//    conversa). Pausa enquanto o Jarvis fala, para não ouvir a si mesmo.
//  - segurar para falar (PTT): só escuta enquanto o botão/Espaço está apertado.
//    Mais confiável em ambiente barulhento e o que menos áudio envia.
//
// Trocar para Whisper/Realtime API no futuro = substituir este arquivo.
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const LS = "jarvis_voz_v1";

  let cb = { onTexto() {}, onInterim() {}, onEstado() {}, onErro() {}, onNivel() {} };
  let rec = null, continuo = false, pausado = false, ptt = null, pttSoltou = false;
  let mudo = false, config = { voz: "", rate: 1.05 };
  try { Object.assign(config, JSON.parse(localStorage.getItem(LS) || "{}")); } catch (_) {}

  // ---------- medidor de microfone ----------
  let stream = null, ac = null, an = null, buf = null, raf = 0;
  async function abrirMic() {
    if (stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cb.onErro("O microfone só funciona em HTTPS ou em localhost. Abra por http://localhost:8000.");
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      stream = null;
      cb.onErro(e && e.name === "NotFoundError"
        ? "Nenhum microfone encontrado neste computador."
        : "Permissão do microfone negada. Clique no cadeado da barra de endereço e permita o microfone.");
      return false;
    }
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      an = ac.createAnalyser(); an.fftSize = 512; buf = new Uint8Array(an.fftSize);
      ac.createMediaStreamSource(stream).connect(an);
      const laco = () => {
        if (!stream) return;
        an.getByteTimeDomainData(buf);
        let s = 0; for (const v of buf) { const d = (v - 128) / 128; s += d * d; }
        cb.onNivel(Math.min(1, Math.sqrt(s / buf.length) * 4));
        raf = requestAnimationFrame(laco);
      };
      laco();
    } catch (_) { /* sem medidor, mas o reconhecimento segue funcionando */ }
    return true;
  }
  function fecharMic() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; cancelAnimationFrame(raf);
    if (ac) { try { ac.close(); } catch (_) {} ac = null; }
    cb.onNivel(0);
  }
  function micEmUso() { return continuo || !!ptt; }

  // ---------- reconhecimento ----------
  function erroDe(e) {
    switch (e) {
      case "no-speech": case "aborted": return null;       // normal: ninguém falou
      case "not-allowed": case "service-not-allowed": return "Permissão do microfone negada.";
      case "audio-capture": return "Nenhum microfone encontrado.";
      case "network": return "O reconhecimento de voz precisa de internet (ele é feito pelo servidor do navegador).";
      case "language-not-supported": return "O navegador não suporta reconhecimento em português.";
      default: return "Erro no reconhecimento de voz: " + e;
    }
  }
  function criarRec(modoContinuo, meta, aoFinal) {
    const r = new SR();
    r.lang = "pt-BR"; r.continuous = modoContinuo; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], t = res[0].transcript.trim();
        if (res.isFinal) { if (t) { cb.onInterim(""); aoFinal(t, meta); } } else interim += res[0].transcript;
      }
      if (interim) cb.onInterim(interim);
    };
    r.onerror = (e) => {
      const m = erroDe(e.error); if (!m) return;
      cb.onErro(m);
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") parar_tudo();
    };
    return r;
  }

  // O Chrome encerra a escuta contínua sozinho de tempos em tempos; reinicia,
  // mas desiste se falhar em sequência (evita laço infinito).
  let falhas = [];
  function reiniciarContinuo() {
    if (!continuo || pausado) return;
    const agora = Date.now();
    falhas = falhas.filter((t) => agora - t < 6000); falhas.push(agora);
    if (falhas.length > 6) { cb.onErro("O reconhecimento de voz ficou instável e foi desligado. Ligue o microfone de novo."); parar_tudo(); return; }
    try { rec.start(); } catch (_) { /* já estava iniciando */ }
  }
  function parar_tudo() {
    continuo = false; pausado = false;
    try { rec && rec.stop(); } catch (_) {}
    try { ptt && ptt.stop(); } catch (_) {}
    ptt = null; cb.onInterim(""); cb.onEstado(false); fecharMic();
  }

  // ---------- fala (TTS) ----------
  let vozes = [], tokenFala = 0;
  function carregarVozes() {
    if (!("speechSynthesis" in window)) return;
    vozes = speechSynthesis.getVoices().filter((v) => /^pt/i.test(v.lang));
    cb.onVozes && cb.onVozes(vozes.map((v) => v.name));
  }
  function vozEscolhida() {
    return vozes.find((v) => v.name === config.voz)
      || vozes.find((v) => /pt-BR/i.test(v.lang) && /natural|google|luciana|francisca|microsoft/i.test(v.name))
      || vozes.find((v) => /pt-BR/i.test(v.lang)) || vozes[0] || null;
  }
  if ("speechSynthesis" in window) { carregarVozes(); speechSynthesis.onvoiceschanged = carregarVozes; }

  // O Chrome corta falas longas (~15 s): fala por frases, e quebra frase gigante.
  function partes(texto) {
    const frases = (String(texto).match(/[^.!?\n]+[.!?]*/g) || []).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (let f of frases) {
      while (f.length > 170) {
        let i = f.lastIndexOf(",", 170); if (i < 60) i = f.lastIndexOf(" ", 170); if (i < 60) i = 170;
        out.push(f.slice(0, i + 1).trim()); f = f.slice(i + 1).trim();
      }
      if (f) out.push(f);
    }
    return out;
  }

  function falarParte(txt, meuToken) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(txt);
      u.lang = "pt-BR"; u.rate = config.rate; const v = vozEscolhida(); if (v) u.voice = v;
      let fim = false; const done = () => { if (!fim) { fim = true; resolve(); } };
      u.onend = done; u.onerror = done;
      setTimeout(done, 3000 + txt.length * 110);      // rede de segurança
      if (meuToken === tokenFala) speechSynthesis.speak(u); else done();
    });
  }

  window.JarvisVoice = {
    suportaEntrada: !!SR,
    suportaSaida: "speechSynthesis" in window,
    _partes: partes,
    configurar(c) { cb = Object.assign(cb, c); },
    get escutando() { return continuo; },
    get segurando() { return !!ptt; },
    get mudo() { return mudo; },
    set mudo(v) { mudo = !!v; if (mudo) this.parar(); },

    vozes() { return vozes.map((v) => v.name); },
    get vozAtual() { const v = vozEscolhida(); return v ? v.name : ""; },
    get velocidade() { return config.rate; },
    setVoz(nome) { config.voz = nome; salvar(); },
    setVelocidade(r) { config.rate = Math.max(0.7, Math.min(1.5, Number(r) || 1)); salvar(); },

    // Microfone contínuo (liga/desliga). Devolve true se ficou ligado.
    async alternarEscuta() {
      if (continuo) { parar_tudo(); return false; }
      if (!SR) { cb.onErro("Este navegador não tem reconhecimento de voz. Use Chrome ou Edge, ou digite."); return false; }
      if (!(await abrirMic())) return false;
      rec = criarRec(true, { ptt: false }, (t, m) => cb.onTexto(t, m));
      rec.onend = () => setTimeout(reiniciarContinuo, 250);
      continuo = true; pausado = false; falhas = [];
      try { rec.start(); } catch (_) {}
      cb.onEstado(true);
      return true;
    },

    // Segurar para falar. soltar() encerra e entrega o que foi dito.
    async segurar() {
      if (ptt || continuo) return false;
      if (!SR) { cb.onErro("Este navegador não tem reconhecimento de voz. Use Chrome ou Edge, ou digite."); return false; }
      this.parar();                                   // o Jarvis cala para você falar
      pttSoltou = false;
      const r = (ptt = criarRec(false, { ptt: true }, (t, m) => cb.onTexto(t, m)));
      if (!(await abrirMic())) { ptt = null; return false; }
      if (pttSoltou || ptt !== r) { ptt = null; if (!micEmUso()) fecharMic(); return false; } // soltou antes de abrir
      r.onend = () => { if (ptt === r) { ptt = null; cb.onInterim(""); cb.onEstado(false); fecharMic(); } };
      try { r.start(); } catch (_) {}
      cb.onEstado(true);
      return true;
    },
    soltar() { pttSoltou = true; const r = ptt; if (!r) return; try { r.stop(); } catch (_) {} },

    // Fala (por frases) e resolve ao terminar ou ser interrompida. Pausa o
    // microfone contínuo enquanto fala, para não ouvir a própria voz.
    async falar(texto) {
      const meu = ++tokenFala;
      const tempo = Math.min(20000, 1200 + texto.length * 55);
      if (mudo || !this.suportaSaida) return new Promise((r) => setTimeout(r, tempo));
      speechSynthesis.cancel();
      if (continuo) { pausado = true; try { rec.stop(); } catch (_) {} }
      try {
        for (const p of partes(texto)) { if (meu !== tokenFala) break; await falarParte(p, meu); }
      } finally {
        if (continuo && meu === tokenFala) { pausado = false; setTimeout(reiniciarContinuo, 350); }
      }
    },
    parar() {
      tokenFala++;
      if (this.suportaSaida) speechSynthesis.cancel();
      // Interrompeu a fala: se o microfone contínuo estava pausado, religa.
      if (continuo && pausado) { pausado = false; setTimeout(reiniciarContinuo, 350); }
    },
    testar() { return this.falar("Olá, eu sou o Jarvis. Esta é a minha voz."); },
  };

  function salvar() { try { localStorage.setItem(LS, JSON.stringify(config)); } catch (_) {} }
})();
