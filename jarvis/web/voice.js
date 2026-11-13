// Voz do Jarvis: entrada e saída, com dois caminhos conforme onde a página roda.
//
// A) DENTRO de um artefato do claude.ai (window.claude existe)
//    - Entrada: capacidade `dictation`. O microfone é da plataforma; a página
//      só recebe TEXTO. Só funciona "segurando para falar" (a voz do Claude fica
//      ocupada enquanto o ditado escuta, então não há modo contínuo).
//    - Saída: capacidade `tts` (voz do Claude). Sem ela, a página mostra o texto.
// B) Em qualquer outro lugar (localhost, GitHub Pages)
//    - Entrada: SpeechRecognition do navegador (Chrome/Edge), contínua ou segurar.
//    - Saída: speechSynthesis do sistema.
//
// PRIVACIDADE. A: o áudio vai ao serviço de fala da Anthropic (o mesmo do chat).
// B: no Chrome/Edge o áudio vai ao servidor do navegador (Google/Microsoft).
// Nos dois casos o áudio sai do computador enquanto o microfone está ativo.
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const LS = "jarvis_voz_v1";
  const NO_ARTEFATO = !!(window.claude && typeof window.claude.use === "function");
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  let cb = { onTexto() {}, onInterim() {}, onEstado() {}, onErro() {}, onNivel() {}, onVozes() {} };
  let config = { voz: "", rate: 1.05 };
  try { Object.assign(config, JSON.parse(localStorage.getItem(LS) || "{}")); } catch (_) {}
  function salvar() { try { localStorage.setItem(LS, JSON.stringify(config)); } catch (_) {} }

  let dict = null, ttsCap = null, ttsVozes = [], detectado = false;
  let mudo = false, tokenFala = 0;

  // =====================================================================
  // Caminho A: capacidades do artefato
  // =====================================================================
  let dictPtt = false, pttBuf = [], pttSoltou = false;

  function msgErroDict(e) {
    const c = e && e.code;
    if (c === "stopped" || c === "dismissed") return null;      // você soltou/fechou: sem aviso
    if (c === "not_granted") return "O ditado não foi permitido. Libere no menu Permissões do artefato.";
    if (c === "unavailable") return "Ditado indisponível neste navegador, app ou idioma. Digite o pedido.";
    if (c === "rate_limited") return "Muitos ditados seguidos. Espere um instante.";
    if (c === "no_gesture") return "Aperte e segure o botão (ou a tecla Espaço) para falar.";
    return "O serviço de ditado falhou. Tente de novo ou digite.";
  }

  function finalizarPtt() {
    if (!dictPtt) return;
    dictPtt = false; cb.onEstado(false); cb.onInterim("");
    const t = pttBuf.join("").replace(/\s+/g, " ").trim(); pttBuf = [];
    if (t) cb.onTexto(t, { ptt: true });
  }

  function ligarDictation() {
    dict.onPartial(({ text }) => { if (dictPtt) cb.onInterim(text || ""); });
    dict.onFinal(({ text }) => { if (dictPtt) pttBuf.push(text); });
    dict.onState(({ state, reason }) => {
      if (state !== "idle" || !dictPtt) return;
      // A plataforma encerrou por conta própria (Stop dela, aba oculta, erro).
      if (reason && reason !== "stopped") {
        const m = msgErroDict({ code: reason === "viewer_stopped" || reason === "hidden" || reason === "time_limit" ? "stopped" : reason });
        finalizarPtt(); if (m) cb.onErro(m);
      }
    });
  }

  const prontoP = (async () => {
    if (NO_ARTEFATO) {
      try { dict = await window.claude.use("dictation"); } catch (_) { dict = null; }
      try { ttsCap = await window.claude.use("tts"); } catch (_) { ttsCap = null; }
      if (dict) ligarDictation();
      if (ttsCap) {
        try { await ttsCap.setRate?.(config.rate); } catch (_) {}
        try { ttsVozes = await ttsCap.voices(); } catch (_) { ttsVozes = []; }
      }
    }
    detectado = true;
    cb.onVozes();
    return info();
  })();

  // =====================================================================
  // Caminho B: navegador comum
  // =====================================================================
  let rec = null, continuo = false, pausado = false, ptt = null;
  let stream = null, ac = null, an = null, buf = null, raf = 0, falhas = [];

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
    } catch (_) { /* sem medidor; o reconhecimento segue */ }
    return true;
  }
  function fecharMic() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; cancelAnimationFrame(raf);
    if (ac) { try { ac.close(); } catch (_) {} ac = null; }
    cb.onNivel(0);
  }
  const micEmUso = () => continuo || !!ptt;

  function erroDe(e) {
    switch (e) {
      case "no-speech": case "aborted": return null;
      case "not-allowed": case "service-not-allowed": return "Permissão do microfone negada.";
      case "audio-capture": return "Nenhum microfone encontrado.";
      case "network": return "O reconhecimento de voz precisa de internet (ele é feito pelo servidor do navegador).";
      case "language-not-supported": return "O navegador não suporta reconhecimento em português.";
      default: return "Erro no reconhecimento de voz: " + e;
    }
  }
  function criarRec(modoContinuo, meta) {
    const r = new SR();
    r.lang = "pt-BR"; r.continuous = modoContinuo; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], t = res[0].transcript.trim();
        if (res.isFinal) { if (t) { cb.onInterim(""); cb.onTexto(t, meta); } } else interim += res[0].transcript;
      }
      if (interim) cb.onInterim(interim);
    };
    r.onerror = (e) => {
      const m = erroDe(e.error); if (!m) return;
      cb.onErro(m);
      if (["not-allowed", "service-not-allowed", "audio-capture"].includes(e.error)) pararTudo();
    };
    return r;
  }
  function reiniciarContinuo() {
    if (!continuo || pausado) return;
    const agora = Date.now();
    falhas = falhas.filter((t) => agora - t < 6000); falhas.push(agora);
    if (falhas.length > 6) { cb.onErro("O reconhecimento de voz ficou instável e foi desligado. Ligue o microfone de novo."); pararTudo(); return; }
    try { rec.start(); } catch (_) {}
  }
  function pararTudo() {
    continuo = false; pausado = false;
    try { rec && rec.stop(); } catch (_) {}
    try { ptt && ptt.stop(); } catch (_) {}
    ptt = null; cb.onInterim(""); cb.onEstado(false); fecharMic();
  }

  // ---------- fala em navegador comum (por frases: o Chrome corta falas longas) ----------
  let vozesSis = [];
  function carregarVozes() {
    if (!("speechSynthesis" in window)) return;
    vozesSis = speechSynthesis.getVoices().filter((v) => /^pt/i.test(v.lang));
    cb.onVozes();
  }
  function vozSisEscolhida() {
    return vozesSis.find((v) => v.name === config.voz)
      || vozesSis.find((v) => /pt-BR/i.test(v.lang) && /natural|google|luciana|francisca|microsoft/i.test(v.name))
      || vozesSis.find((v) => /pt-BR/i.test(v.lang)) || vozesSis[0] || null;
  }
  if ("speechSynthesis" in window) { carregarVozes(); speechSynthesis.onvoiceschanged = carregarVozes; }

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
      u.lang = "pt-BR"; u.rate = config.rate; const v = vozSisEscolhida(); if (v) u.voice = v;
      let fim = false; const done = () => { if (!fim) { fim = true; resolve(); } };
      u.onend = done; u.onerror = done;
      setTimeout(done, 3000 + txt.length * 110);
      if (meuToken === tokenFala) speechSynthesis.speak(u); else done();
    });
  }

  // =====================================================================
  // API
  // =====================================================================
  function info() {
    const entrada = dict ? "ditado" : (!NO_ARTEFATO && SR) ? "navegador" : null;
    const saida = ttsCap ? "claude" : ("speechSynthesis" in window) ? "navegador" : null;
    return { artefato: NO_ARTEFATO, entrada, continuo: entrada === "navegador", saida };
  }

  // O iOS/Safari só deixa o sistema falar depois de um gesto do usuário: no primeiro
  // toque/tecla fazemos uma fala vazia para destravar, e as seguintes já saem.
  let destravada = false;
  function destravar() {
    if (destravada || !("speechSynthesis" in window)) return;
    destravada = true;
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch (_) {}
  }
  if (typeof document !== "undefined") ["pointerdown", "touchend", "keydown", "click"].forEach((ev) => document.addEventListener(ev, destravar, { once: true, passive: true }));

  window.JarvisVoice = {
    _partes: partes,
    pronto: prontoP,
    info,
    configurar(c) { cb = Object.assign(cb, c); },
    get escutando() { return continuo; },
    get segurando() { return dictPtt || !!ptt; },
    get mudo() { return mudo; },
    set mudo(v) { mudo = !!v; if (mudo) this.parar(); },

    vozes() { return ttsCap ? ttsVozes.slice() : vozesSis.map((v) => v.name); },
    get vozAtual() {
      if (ttsCap) return ttsVozes.includes(config.voz) ? config.voz : (ttsVozes[0] || "");
      const v = vozSisEscolhida(); return v ? v.name : "";
    },
    get velocidade() { return config.rate; },
    setVoz(nome) { config.voz = nome; salvar(); },
    setVelocidade(r) {
      config.rate = Math.max(0.7, Math.min(1.5, Number(r) || 1)); salvar();
      if (ttsCap && ttsCap.setRate) ttsCap.setRate(config.rate).catch(() => {});
    },

    // Microfone contínuo (só em navegador comum).
    async alternarEscuta() {
      if (continuo) { pararTudo(); return false; }
      if (NO_ARTEFATO) { cb.onErro("Nesta página use Segurar para falar (botão 🗣 ou tecla Espaço)."); return false; }
      if (!SR) { cb.onErro("Este navegador não tem reconhecimento de voz. Use Chrome ou Edge, ou digite."); return false; }
      if (!(await abrirMic())) return false;
      rec = criarRec(true, { ptt: false });
      rec.onend = () => setTimeout(reiniciarContinuo, 250);
      continuo = true; pausado = false; falhas = [];
      try { rec.start(); } catch (_) {}
      cb.onEstado(true);
      return true;
    },

    // Segurar para falar. Em artefato, dict.start() TEM de ser chamado direto do
    // clique/tecla, sem nenhum await antes: por isso não há await acima dele.
    async segurar() {
      if (this.segurando || continuo) return false;
      if (dict) {
        dictPtt = true; pttBuf = []; pttSoltou = false;
        this.parar();
        const p = dict.start();
        cb.onEstado(true);
        try { await p; }
        catch (e) { dictPtt = false; pttBuf = []; cb.onEstado(false); const m = msgErroDict(e); if (m) cb.onErro(m); return false; }
        if (pttSoltou) await this.soltar();
        return true;
      }
      if (NO_ARTEFATO) { cb.onErro(detectado ? "Ditado indisponível neste navegador ou app. Digite o pedido." : "Preparando a voz… tente de novo em um instante."); return false; }
      if (!SR) { cb.onErro("Este navegador não tem reconhecimento de voz. Use Chrome ou Edge, ou digite."); return false; }
      this.parar(); pttSoltou = false;
      const r = (ptt = criarRec(false, { ptt: true }));
      if (!(await abrirMic())) { ptt = null; return false; }
      if (pttSoltou || ptt !== r) { ptt = null; if (!micEmUso()) fecharMic(); return false; }
      r.onend = () => { if (ptt === r) { ptt = null; cb.onInterim(""); cb.onEstado(false); fecharMic(); } };
      try { r.start(); } catch (_) {}
      cb.onEstado(true);
      return true;
    },
    async soltar() {
      pttSoltou = true;
      if (dict) {
        if (!dictPtt) return;
        try { await dict.stop(); } catch (_) {}
        finalizarPtt();
        return;
      }
      const r = ptt; if (!r) return; try { r.stop(); } catch (_) {}
    },

    // Fala e resolve ao terminar ou ser interrompida.
    async falar(texto) {
      const meu = ++tokenFala;
      const tempo = Math.min(20000, 1200 + texto.length * 55);
      if (mudo) return dormir(tempo);

      if (ttsCap) {
        // "busy" = o ditado ainda está fechando; tenta de novo em instantes.
        for (let i = 0; i < 5; i++) {
          try {
            const op = { language: "pt-BR", rate: config.rate };
            if (ttsVozes.includes(config.voz)) op.voice = config.voz;
            await ttsCap.speak(texto.slice(0, 2000), op);
            return;
          } catch (e) {
            if (meu !== tokenFala) return;
            const c = e && e.code;
            if (c === "busy") { await dormir(350); continue; }
            if (c === "not_granted") { cb.onErro("A voz está desligada nas Permissões do artefato. O texto continua na tela."); return; }
            if (c === "rate_limited") { cb.onErro("Muita fala seguida. Espere um instante."); return; }
            if (c === "stopped") return;
            break;                                                // sem gesto / indisponível / erro: tenta a voz do aparelho
          }
        }
        if (meu !== tokenFala) return;
      }
      if (!("speechSynthesis" in window)) return dormir(tempo);

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
      if (ttsCap) { try { ttsCap.stop().catch(() => {}); } catch (_) {} }
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      if (continuo && pausado) { pausado = false; setTimeout(reiniciarContinuo, 350); }
    },
    testar() { return this.falar("Olá, eu sou o Jarvis. Esta é a minha voz."); },
  };
})();
