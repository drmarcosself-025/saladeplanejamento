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

  // O reconhecimento de voz nem sempre escreve "Jarvis". Variantes comuns:
  const CHAMADA = /\b(jarvis|jarvi|jarves|jarvez|jarvs|jarviz|jarbis|charvis|ja vis)\b/g;
  const chamou = (t) => { CHAMADA.lastIndex = 0; return CHAMADA.test(norm(t)); };

  const SAIR =/\b((volta|retorna)(r)? ao normal|modo normal|desativa( o)?( agente| modo)?|desliga( o)?( agente| modo)?|sair do modo|encerra)\b/;
  const ATIVAR = /\b(ativa|ativar|liga|ligar|abre|abrir|entra|entrar|modo|agente)\b/;
  const CONFIRMA = /^(confirma|confirmo|confirmado|pode enviar|pode mandar|manda|envia|sim|isso|autorizo)$/;
  const CANCELA = /^(cancela|cancelar|nao|deixa|esquece|para|pare)$/;

  // "manda mensagem pro João dizendo que ...", "entra em contato com o fulano".
  // Roda no texto ORIGINAL (para preservar acento e maiúscula da mensagem);
  // os verbos e conectores abaixo não têm acento, então i-flag basta.
  const MSG_PRE = /^\W*(?:(?:jarvis|jarvi|jarves|jarvez|jarvs|jarviz|jarbis|charvis)\W+)?(?:(?:entra|abre)\s+(?:no|na)\s+(?:meu\s+)?(?:whatsapp|zap)\s+e\s+)?(?:manda(?:r)?|mande|envia(?:r)?|envie|escreve(?:r)?|escreva|chama(?:r)?|chame|fala(?:r)?|fale|avisa(?:r)?|avise|entra(?:r)?\s+em\s+contato|entre\s+em\s+contato|contata(?:r)?|contate)\s+(?:uma\s+)?(?:mensagem\s+|msg\s+|whatsapp\s+|zap\s+)?(?:no\s+(?:whatsapp|zap)\s+)?(?:para\s+|pra\s+|pro\s+|com\s+|ao\s+|a\s+)?(?:(?:o|a)\s+)?(.+)$/i;
  const MSG_SEP = /\s+(?:dizendo(?:\s+que)?|falando(?:\s+que)?|avisando(?:\s+que)?|com\s+a\s+mensagem|e\s+diz(?:\s+que)?|e\s+fala(?:\s+que)?)\s+/i;

  function lerMensagem(textoBruto) {
    const m = String(textoBruto || "").match(MSG_PRE);
    if (!m) return null;
    let resto = m[1].trim();
    let nome = resto, mensagem = null;
    const s = resto.match(MSG_SEP);
    if (s) {
      nome = resto.slice(0, s.index);
      mensagem = resto.slice(s.index + s[0].length).trim();
    }
    nome = nome.replace(/[.,;!?]+$/g, "").trim();
    if (!nome) return null;
    if (mensagem) mensagem = mensagem.charAt(0).toUpperCase() + mensagem.slice(1);
    return { nome, mensagem: mensagem || null };
  }

  const STOP = new Set(["o", "a", "os", "as", "do", "da", "de", "dos", "das", "meu", "minha"]);
  // Contatos cujo nome contém todas as palavras pedidas (sem acento/maiúscula).
  // Nome exatamente igual ganha dos parciais.
  function acharContato(consulta, contatos) {
    const q = norm(consulta).split(" ").filter((w) => w && !STOP.has(w));
    if (!q.length) return [];
    const exato = contatos.filter((c) => norm(c.nome) === norm(consulta));
    if (exato.length) return exato;
    return contatos.filter((c) => {
      const n = norm(c.nome).split(" ");
      return q.every((w) => n.some((p) => p.startsWith(w)));
    });
  }

  // Link do WhatsApp com a mensagem pronta (você só toca em enviar).
  function linkWhatsapp(telefone, mensagem) {
    let d = String(telefone || "").replace(/\D/g, "");
    if (d.length === 10 || d.length === 11) d = "55" + d;      // DDD sem país → Brasil
    if (d.length < 12 || d.length > 15) return null;
    return `https://wa.me/${d}` + (mensagem ? `?text=${encodeURIComponent(mensagem)}` : "");
  }


  // ---------- leads: novo, lista, etapa, adiar, retorno ----------
  const CHAMA = "(?:jarvis|jarvi|jarves|jarvez|jarvs|jarviz|jarbis|charvis)";
  const NOVO_LEAD = new RegExp("^\\W*(?:" + CHAMA + "\\W+)?(?:novo|nova|cadastra|cadastrar|cadastre|adiciona|adicionar|adicione|anota|anotar|anote|registra|registrar|registre|salva|salvar)\\s+(?:um\\s+|uma\\s+|o\\s+|a\\s+)?(?:novo\\s+|nova\\s+)?lead\\b\\W*(.*)$", "i");
  const KW = /\b(?:veio|vem|chegou|quer|interessad[oa]s?|procura|pergunt\w+)\b/i;

  function lerNovoLead(resto) {
    let s = " " + resto.trim() + " ", tel = null;
    const m = s.match(/(\+?\(?\d[\d\s().-]{8,}\d)/);
    if (m) { tel = m[1].trim(); s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); }
    s = s.replace(/\s+/g, " ").trim();
    const k = s.search(KW), v = s.search(/[,;]/);
    const fim = [k, v].filter((x) => x >= 0).sort((a, b) => a - b)[0];
    const nome = (fim === undefined ? s : s.slice(0, fim)).replace(/^(?:o|a)\s+/i, "").replace(/[,;:.]+$/g, "").trim();
    const mo = s.match(/\b(?:veio|vem|chegou)\s+(?:d[oae]s?|pel[oa]s?|por|de)\s+(.+?)(?=\s+(?:e\s+)?(?:quer|interessad|procura|pergunt)|[,;.]|$)/i);
    const mi = s.match(/\b(?:quer|interessad[oa]s?\s+(?:em|no|na|nos|nas)|procura|pergunt\w+\s+(?:sobre|do|da|de))\s+(.+?)(?=[,;.]|$)/i);
    return { tipo: "lead_novo", nome, tel, origem: mo ? mo[1].trim() : null, interesse: mi ? mi[1].trim() : null };
  }

  const ETAPA_MAP = { novo: "novo", conversando: "conversando", orcamento: "orcamento", "orcamento enviado": "orcamento", agendou: "agendou", agendado: "agendou", fechou: "fechou", fechado: "fechou", perdido: "perdido", perdeu: "perdido", fechamos: "fechou", desistiu: "perdido", sumiu: "perdido" };
  const ETAPA_RE = /^(?:marca|marcar|marque|move|mover|mova|muda|mudar|mude|atualiza|atualizar|atualize|passa|passar|passe|coloca|colocar|coloque)\s+(?:o\s+|a\s+)?(.+?)\s+(?:como|para|pra|em)\s+(novo|conversando|orcamento(?: enviado)?|agendou|agendado|fechou|fechado|perdido|perdeu)$/;
  const ETAPA_SOLTA = /^(?:o\s+|a\s+)?(.+?)\s+(agendou|fechou|fechamos|perdeu|desistiu|sumiu)$/;
  const SUF = /\s+(?:(?:para|pra|so|somente|em|no|na|dia|daqui a|daqui)\s+)?((?:depois de )?amanha|hoje|(?:(?:daqui a|em)\s+)?\d{1,3}\s+dias?|(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:\s+feira)?|(?:a\s+)?(?:semana que vem|proxima semana)|\d{1,2}\/\d{1,2})$/;
  const ADIAR_RE = /^(?:adia|adiar|adie|reagenda|reagendar|reagende|remarca|remarcar|remarque|empurra|empurrar|empurre)\s+(?:o\s+|a\s+|pro\s+|pra\s+|para\s+)?(.+)$/;
  const RETORNO_RE = /^(?:retorna|retornar|retorne|cobra|cobrar|cobre|da retorno|dar retorno|faz retorno|fazer retorno|follow up)\s+(?:(?:pro|pra|para|ao|a|o)\s+)?(?:(?:o|a)\s+)?(.+)$/;
  const LISTA_RE = [
    /\b(quem|quais|que)\b.*\b(retornar|retorno|retornos|cobrar|ligar|chamar)\b/,
    /\b(retornos?|follow ?ups?)\b.*\b(hoje|atrasad\w+|pendente\w*)\b/,
    /\b(meus|mostra|mostrar|lista|listar|ver|abre|abrir)\b.*\b(leads?|funil|retornos)\b/,
    /\bleads?\b.*\b(hoje|atrasad\w+|pendente\w*)\b/,
  ];

  // t = texto normalizado (sem "jarvis"); original = texto como falado/digitado.
  function lerLead(original, t, hoje) {
    const nl = String(original || "").match(NOVO_LEAD);
    if (nl) return lerNovoLead(nl[1] || "");
    if (LISTA_RE.some((r) => r.test(t))) return { tipo: "lead_lista", filtro: /atrasad/.test(t) ? "atrasados" : /\b(todos|meus|funil|lista|listar|mostra|mostrar|ver|abre|abrir)\b/.test(t) ? "todos" : "devidos" };
    let m = t.match(ETAPA_RE);
    if (m) return { tipo: "lead_etapa", nome: m[1].trim(), etapa: ETAPA_MAP[m[2]] };
    m = t.match(ADIAR_RE) || t.match(RETORNO_RE);
    if (m) {
      const resto = m[1].trim(), sf = resto.match(SUF);
      const ehAdiar = ADIAR_RE.test(t);
      if (sf) {
        const L = window.JarvisLeads;
        return { tipo: "lead_adiar", nome: resto.slice(0, sf.index).trim(), quando: L ? L.dataDe(sf[1], hoje) : null };
      }
      return ehAdiar ? { tipo: "lead_adiar", nome: resto, quando: null } : { tipo: "lead_retorno", nome: resto };
    }
    m = t.match(ETAPA_SOLTA);
    if (m && t.split(" ").length <= 5) return { tipo: "lead_etapa", nome: m[1].trim(), etapa: ETAPA_MAP[m[2]], solto: true };
    return null;
  }

  // Devolve { tipo, modo?, texto, nome?, mensagem? }
  //  tipo: "sair" | "ativar" | "confirmar" | "cancelar" | "mensagem" | "pergunta" | "vazio"
  function interpretar(textoBruto, modos, hoje) {
    let t = norm(textoBruto).replace(CHAMADA, "").replace(/\s+/g, " ").trim();
    if (!t) return { tipo: "vazio", texto: "" };

    if (CONFIRMA.test(t)) return { tipo: "confirmar", texto: t };
    if (CANCELA.test(t)) return { tipo: "cancelar", texto: t };
    if (SAIR.test(t)) return { tipo: "sair", texto: t };

    const lead = lerLead(textoBruto, t, hoje);
    if (lead) return { ...lead, texto: t };

    const msg = lerMensagem(textoBruto);
    if (msg) return { tipo: "mensagem", texto: t, nome: msg.nome, mensagem: msg.mensagem };

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
    chamou,
    interpretar,
    acharContato,
    linkWhatsapp,
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
