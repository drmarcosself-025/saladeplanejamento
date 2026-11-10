// Cérebro local: entende comandos de troca de modo e responde perguntas
// simples dos modos. É determinístico de propósito: trocar de modo, confirmar
// e cancelar NUNCA passam por IA (rápido, previsível e sem risco).
//
// Perguntas abertas vão para o backend (APP_CONFIG.BRAIN_URL → Edge Function
// `jarvis-brain`, que usa Claude + ferramentas). Sem backend, o modo
// demonstração responde só o que está mapeado aqui e diz claramente quando
// não sabe — não inventa resposta.
(function () {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const SAIR = /\b(volta(r)? ao normal|modo normal|desativa( o)?( agente| modo)?|desliga( o)?( agente| modo)?|sair do modo|encerra)\b/;
  const ATIVAR = /\b(ativa|ativar|liga|ligar|abre|abrir|entra|entrar|modo|agente)\b/;
  const CONFIRMA = /^(confirma|confirmo|confirmado|pode enviar|pode mandar|manda|envia|sim|isso|autorizo)$/;
  const CANCELA = /^(cancela|cancelar|nao|deixa|esquece|para|pare)$/;

  // Devolve { tipo, modo?, texto }
  //  tipo: "sair" | "ativar" | "confirmar" | "cancelar" | "pergunta" | "vazio"
  function interpretar(textoBruto, modos) {
    let t = norm(textoBruto).replace(/\bjarvis\b/g, "").replace(/\s+/g, " ").trim();
    if (!t) return { tipo: "vazio", texto: "" };

    if (CONFIRMA.test(t)) return { tipo: "confirmar", texto: t };
    if (CANCELA.test(t)) return { tipo: "cancelar", texto: t };
    if (SAIR.test(t)) return { tipo: "sair", texto: t };

    // Ativar um modo: precisa de verbo/“modo”/“agente” + apelido do modo.
    // Maior apelido primeiro, para "social media" ganhar de "social".
    const candidatos = [];
    for (const m of Object.values(modos)) {
      for (const a of m.aliases) candidatos.push({ modo: m.id, alias: a });
    }
    candidatos.sort((x, y) => y.alias.length - x.alias.length);
    const achou = candidatos.find((c) => new RegExp(`\\b${c.alias}\\b`).test(t));
    if (achou && (ATIVAR.test(t) || t === achou.alias)) {
      return { tipo: "ativar", modo: achou.modo, texto: t };
    }
    return { tipo: "pergunta", texto: t };
  }

  // Respostas demonstrativas por modo. Retornam { fala, acao? } ou null.
  // `acao` é uma ação PENDENTE: só executa se o usuário disser "confirma".
  function demoResponder(modoId, t, d) {
    if (modoId === "gestao") {
      const pend = d.pacientes.filter((p) => !p.confirmado);
      if (/confirm|paciente|agenda/.test(t)) {
        const lista = pend.map((p) => `${p.hora} ${p.nome}`).join(", ");
        return {
          fala: `Faltam ${pend.length} confirmações: ${lista}. Preparei a mensagem de cada um. Posso marcar como enviadas? Diga confirma.`,
          acao: {
            id: "agenda.preparar_confirmacoes",
            nivel: "EXECUTE",
            titulo: `Enviar ${pend.length} confirmações de consulta`,
            detalhe: pend.map((p) => `${p.hora} · ${p.nome} · ${p.proc}`),
            exemplo: `Olá! Aqui é da clínica. Passando para confirmar sua consulta de amanhã às ${pend[0] ? pend[0].hora : "--:--"}. Pode confirmar? 😊`,
          },
        };
      }
      if (/conta|boleto|pagar|venc/.test(t)) {
        return { fala: "Contas desta semana: " + d.contas.map((c) => `${c.quem}, R$ ${c.valor.toFixed(2).replace(".", ",")}, vence ${c.vence}`).join("; ") + ". Eu só lembro, não pago nada sozinho." };
      }
      if (/e mail|email|mensag/.test(t)) {
        return { fala: "E-mails que pedem resposta: " + d.emails.map((e) => `${e.de}, ${e.assunto}`).join("; ") + ". Quer que eu prepare rascunhos?" };
      }
    }
    if (modoId === "trafego" && /analis|campanha|resultado/.test(t)) {
      return { fala: `Em demonstração: o custo por conversa ficou em ${d.cpl_fmt}. Com o backend ligado, eu comparo campanha a campanha e sugiro o que pausar.` };
    }
    if (modoId === "social" && /arte|post|criar/.test(t)) {
      return { fala: "Em demonstração. Com o backend ligado, eu gero a arte e a legenda, mostro aqui e só publico depois do seu confirma." };
    }
    return null;
  }

  window.JarvisBrain = {
    norm,
    interpretar,
    demoResponder,

    // Pergunta aberta: backend se existir; senão, demonstração honesta.
    async perguntar({ modoId, texto, dados }) {
      const url = window.APP_CONFIG && window.APP_CONFIG.BRAIN_URL;
      if (url) {
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 25000);
          const r = await fetch(url, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${window.APP_CONFIG.JARVIS_TOKEN || ""}`,
            },
            body: JSON.stringify({ mode: modoId, text: texto }),
          });
          clearTimeout(to);
          if (r.ok) {
            const j = await r.json();
            return { fala: j.speech, acao: j.pending_action || null, fonte: "claude" };
          }
        } catch (_) { /* cai para demo */ }
      }
      const d = demoResponder(modoId, norm(texto), dados);
      if (d) return { ...d, fonte: "demo" };
      return {
        fala: "Ainda estou em modo demonstração e não tenho cérebro ligado para essa pergunta. Quando o backend estiver conectado, ela vai para o Claude com as ferramentas deste agente.",
        fonte: "demo",
      };
    },
  };
})();
