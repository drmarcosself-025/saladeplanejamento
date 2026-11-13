// Cérebro local: entende comandos de troca de modo e responde perguntas
// simples dos modos. É determinístico de propósito: trocar de modo, confirmar
// e cancelar NUNCA passam por IA (rápido, previsível e sem risco).
//
// Perguntas abertas usam a capacidade sample do artefato; nunca executam ações.
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


  // ---------- leads, CRM e financeiro ----------
  const CHAMA = "(?:jarvis|jarvi|jarves|jarvez|jarvs|jarviz|jarbis|charvis)";
  const PRE = "^\\W*(?:" + CHAMA + "\\W+)?";
  const NOVO_LEAD = new RegExp(PRE + "(?:novo|nova|cadastra|cadastrar|cadastre|adiciona|adicionar|adicione|anota|anotar|anote|registra|registrar|registre|salva|salvar)\\s+(?:um\\s+|uma\\s+|o\\s+|a\\s+)?(?:novo\\s+|nova\\s+)?lead\\b\\W*(.*)$", "i");
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

  // Etapas aceitas por voz: o que você diz → etapa do funil.
  const ETAPA_MAP = { novo: "novo", interessado: "interessado", conversando: "interessado", proposta: "proposta", "proposta enviada": "proposta", orcamento: "proposta", "orcamento enviado": "proposta", aguardando: "aguardando", "aguardando retorno": "aguardando", agendou: "agendou", agendado: "agendou", fechou: "fechou", fechado: "fechou", "sem interesse": "sem_interesse", perdido: "sem_interesse", perdeu: "sem_interesse" };
  const ETAPA_ALT = "novo|interessado|conversando|proposta(?: enviada)?|orcamento(?: enviado)?|aguardando(?: retorno)?|agendou|agendado|fechou|fechado|sem interesse|perdido|perdeu";
  const ETAPA_RE = new RegExp("^(?:marca|marcar|marque|move|mover|mova|muda|mudar|mude|atualiza|atualizar|atualize|passa|passar|passe|coloca|colocar|coloque)\\s+(?:o\\s+|a\\s+)?(.+?)\\s+(?:como|para|pra|em)\\s+(" + ETAPA_ALT + ")$");
  // "o João demonstrou interesse", "passei a proposta pro João"... (o nome só vale se existir um lead com ele)
  const SOLTAS = [
    [/^(?:o\s+|a\s+)?(.+?)\s+(?:agendou|marcou consulta|marcou)$/, "agendou"],
    [/^(?:o\s+|a\s+)?(.+?)\s+(?:fechou|fechamos|fechou o tratamento)$/, "fechou"],
    [/^(?:o\s+|a\s+)?(.+?)\s+(?:nao tem interesse|nao quis|nao quer|nao se interessou|recusou|perdeu|desistiu|sumiu)$/, "sem_interesse"],
    [/^(?:o\s+|a\s+)?(.+?)\s+(?:demonstrou interesse|se interessou|tem interesse|quer saber mais|gostou)$/, "interessado"],
    [/^(?:o\s+|a\s+)?(.+?)\s+(?:ficou de dar retorno|ficou de responder|vai pensar|vai ver|pediu um tempo)$/, "aguardando"],
    [/^(?:passei|mandei|enviei)\s+(?:a\s+)?(?:proposta|orcamento)\s+(?:pro|pra|para|ao|a|o)\s+(?:o\s+|a\s+)?(.+)$/, "proposta"],
    [/^(?:agendei|marquei consulta (?:pro|pra|para|do|da))\s+(?:o\s+|a\s+)?(.+)$/, "agendou"],
  ];
  const SUF = /\s+(?:(?:para|pra|so|somente|em|no|na|dia|daqui a|daqui)\s+)?((?:depois de )?amanha|hoje|(?:(?:daqui a|em)\s+)?\d{1,3}\s+dias?|(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:\s+feira)?|(?:a\s+)?(?:semana que vem|proxima semana)|\d{1,2}\/\d{1,2})$/;
  const ADIAR_RE = /^(?:adia|adiar|adie|reagenda|reagendar|reagende|remarca|remarcar|remarque|empurra|empurrar|empurre)\s+(?:o\s+|a\s+|pro\s+|pra\s+|para\s+)?(.+)$/;
  const RETORNO_RE = /^(?:retorna|retornar|retorne|cobra|cobrar|cobre|da retorno|dar retorno|faz retorno|fazer retorno|follow up)\s+(?:(?:pro|pra|para|ao|a|o)\s+)?(?:(?:o|a)\s+)?(.+)$/;
  const LISTA_RE = [
    /\b(quem|quais|que)\b.*\b(retornar|retorno|retornos|cobrar|ligar|chamar)\b/,
    /\b(retornos?|follow ?ups?)\b.*\b(hoje|atrasad\w+|pendente\w*)\b/,
    /\b(meus|mostra|mostrar|lista|listar|ver|abre|abrir)\b.*\b(leads?|funil|retornos)\b/,
    /\bleads?\b.*\b(hoje|atrasad\w+|pendente\w*)\b/,
  ];
  const NOTA_RE = new RegExp(PRE + "(?:anota|anotar|anote|registra|registrar|registre)\\s+(?:pro|pra|para|no|na)\\s+(?:o\\s+|a\\s+)?(.+?)\\s*[:,-]\\s*(.+)$", "i");
  const VALOR_RE = new RegExp(PRE + "(?:o\\s+|a\\s+)?(.+?)\\s+(?:vale|tem valor de|proposta de|or[çc]amento de|proposta ficou em|or[çc]amento ficou em)\\s+(.+)$", "i");

  // t = texto normalizado (sem "jarvis"); original = texto como falado/digitado.
  function lerLead(original, t, hoje) {
    if (/\bcrm\b|\bkanban\b|\bpipeline\b/.test(t)) {
      if (/\b(fecha|fechar|feche|sai|sair)\b/.test(t)) return { tipo: "crm_fechar" };
      return { tipo: "crm_abrir" };
    }
    const nl = String(original || "").match(NOVO_LEAD);
    if (nl) return lerNovoLead(nl[1] || "");
    let m = String(original || "").match(NOTA_RE);
    if (m) return { tipo: "lead_nota", nome: norm(m[1]), nota: m[2].trim() };   // `nota` (e não `texto`, que o roteador sobrescreve)
    m = t.match(/^(?:detalhes|ficha|historico|perfil)\s+(?:d[oae]s?\s+|de\s+)?(?:lead\s+)?(.+)$/) || t.match(/^(?:abre|abrir|abra|mostra|mostrar)\s+(?:o\s+)?lead\s+(?:d[oae]\s+)?(.+)$/);
    if (m) return { tipo: "lead_detalhe", nome: m[1].trim() };
    if (LISTA_RE.some((r) => r.test(t))) return { tipo: "lead_lista", filtro: /atrasad/.test(t) ? "atrasados" : /\b(todos|meus|funil|lista|listar|mostra|mostrar|ver|abre|abrir)\b/.test(t) ? "todos" : "devidos" };
    m = t.match(ETAPA_RE);
    if (m) return { tipo: "lead_etapa", nome: m[1].trim(), etapa: ETAPA_MAP[m[2]] };
    m = String(original || "").match(VALOR_RE);
    const F = window.JarvisFin;
    if (m && F && F.lerValor(m[2]) > 0) return { tipo: "lead_valor", nome: norm(m[1]), valor: F.lerValor(m[2]) };
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
    if (t.split(" ").length <= 8) for (const [re, etapa] of SOLTAS) { m = t.match(re); if (m) return { tipo: "lead_etapa", nome: m[1].trim(), etapa, solto: true }; }
    return null;
  }

  // ---------- financeiro (modo Contador) ----------
  // Monta { tipo, valor, descricao, status, data, vencimento } a partir do texto depois do verbo.
  function montarLanc(rest, tipo, status, hoje) {
    const F = window.JarvisFin, L = window.JarvisLeads;
    let s = " " + rest + " ", venc = null, data = null;
    const mv = s.match(/\bvenc\w*\s+(?:no\s+|em\s+)?(.+?)\s*$/i);
    if (mv) { venc = L.dataDe(mv[1], hoje); s = s.slice(0, mv.index); status = "pendente"; }
    const md = s.match(/\b(anteontem|ontem|hoje|dia\s+\d{1,2}|\d{1,2}\/\d{1,2})\b/i);
    if (md && !mv) { data = L.dataDe(md[1], hoje); s = s.replace(md[0], " "); }
    const valor = F.lerValor(s);
    if (valor == null) return { tipo: "fin_lancar", erro: "valor", lanc: { tipo, status, descricao: s.trim() } };
    s = s.replace(/R\$\s*/gi, "").replace(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)?)(\s*mil\b)?(\s*reais?)?/i, " ");
    const descricao = s.replace(/\s+/g, " ").trim().replace(/^(?:de|do|da|dos|das|com|no|na|em|pra|pro|para|um|uma|o|a|valor)\s+/i, "").replace(/\s+(?:de|do|da|com|no|na|em)$/i, "").trim();
    return { tipo: "fin_lancar", lanc: { tipo, valor, descricao, status, data, vencimento: venc } };
  }
  function lerFin(original, t, hoje) {
    const F = window.JarvisFin; if (!F) return null;
    if (/\b(fecha|fechar|feche|fechamento)\b.*\b(mes|caixa|financeiro)\b/.test(t)) return { tipo: "fin_fechar", mes: F.mesDeTexto(t, hoje) };
    // despesas fixas: "lança as fixas do mês" (sem número) / "cadastra despesa fixa aluguel 2800 dia 5"
    if (!/\d/.test(original) && /\b(fixas?|recorrentes?)\b/.test(t) && /\b(lanca\w*|gera\w*|coloca\w*|puxa\w*|adiciona\w*)\b/.test(t)) return { tipo: "fin_fixas", mes: F.mesDeTexto(t, hoje) };
    let mf = original.match(new RegExp(PRE + "(?:cadastra|cadastrar|cadastre|lan[çc]a|lan[çc]ar|registra|registrar|adiciona|adicionar)\\s+(?:uma\\s+|um\\s+)?(?:despesa|conta|gasto)\\s+(?:fixa|recorrente|mensal)\\s*(.*)$", "i"));
    if (mf) {
      let s = " " + mf[1] + " ", dia = 1; const md = s.match(/\bdia\s+(\d{1,2})\b/i);
      if (md) { dia = +md[1]; s = s.replace(md[0], " "); }
      const valor = F.lerValor(s);
      if (valor == null) return { tipo: "fin_fixa_nova", erro: "valor" };
      s = s.replace(/R\$\s*/gi, "").replace(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)?)(\s*mil\b)?(\s*reais?)?/i, " ");
      return { tipo: "fin_fixa_nova", fixa: { descricao: s.replace(/\s+/g, " ").trim().replace(/^(?:de|do|da|com|no|na|em|o|a)\s+/i, ""), valor, dia } };
    }
    const temNumero = /\d/.test(original);      // com valor, "conta de X 189,90" é lançamento; sem valor, é consulta
    if (!temNumero && (/\b(contas?|boletos?|despesas?)\b.*\b(pagar|vencer|vencem|vence|atrasad\w+|pendentes?)\b/.test(t) || /\b(o que|quanto)\b.*\b(tenho|falta|preciso|devo)\b.*\bpagar\b/.test(t))) return { tipo: "fin_pendentes" };
    if (/\b(quanto|resumo|balanco|como (?:esta|foi|ficou|anda))\b.*\b(gastei|gasto|gastos|recebi|faturei|faturamento|lucro|financeiro|financas|caixa|saldo|receita|receitas|despesa|despesas)\b/.test(t)
      || /^(?:resumo|balanco)\s+(?:do\s+|de\s+)?(?:mes|financeiro)/.test(t) || /\bfinanceiro\b.*\b(mes|resumo)\b/.test(t)) return { tipo: "fin_resumo", mes: F.mesDeTexto(t, hoje) };
    let m = original.match(new RegExp(PRE + "(?:lan[çc]a|lan[çc]ar|lance|registra|registrar|registre|anota|anotar|anote|adiciona|adicionar|adicione)\\s+(?:uma\\s+|um\\s+)?(despesa|gasto|conta|boleto|receita|entrada|recebimento|pagamento)\\b\\s*(.*)$", "i"));
    if (m) { const rec = /receita|entrada|recebimento/i.test(m[1]); return montarLanc(m[2], rec ? "receita" : "despesa", /conta|boleto/i.test(m[1]) ? "pendente" : "pago", hoje); }
    m = original.match(new RegExp(PRE + "(?:recebi|entrou|caiu|ganhei|faturei)\\s+(.+)$", "i"));
    if (m) return montarLanc(m[1], "receita", "pago", hoje);
    m = original.match(new RegExp(PRE + "(?:paguei|quitei|dei baixa(?:\\s+n[ao])?|baixa|gastei|comprei)\\s+(.+)$", "i"));
    if (m) {
      const r = montarLanc(m[1], "despesa", "pago", hoje);
      if (r.erro === "valor" && /^(?:paguei|quitei|dei baixa|baixa)/i.test(original.replace(new RegExp(PRE, "i"), ""))) return { tipo: "fin_pagar", nome: norm(m[1]).replace(/^(?:a|o|as|os)\s+/, "").replace(/^(?:conta|boleto|fatura)\s+(?:de|da|do)\s+/, "").replace(/^(?:conta|boleto|fatura)\s+/, "") };
      return r;
    }
    m = original.match(new RegExp(PRE + "(?:conta|boleto|fatura)\\s+(?:de\\s+|da\\s+|do\\s+)?(.+)$", "i"));
    if (m) return montarLanc(m[1], "despesa", "pendente", hoje);
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
    const fin = lerFin(textoBruto, t, hoje);
    if (fin) return { ...fin, texto: t };

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

  // ---------- cérebro: Claude (capacidade `sample` do claude.ai) ----------
  // Só informa, orienta e propõe. NUNCA executa: ações passam pelo roteador
  // determinístico, com o seu "confirma" quando for o caso.
  let amostra;
  async function obterAmostra() {
    if (amostra !== undefined) return amostra;
    try { amostra = window.claude && typeof window.claude.use === "function" ? await window.claude.use("sample") : null; } catch (_) { amostra = null; }
    return amostra;
  }
  const COMANDOS = ["quem preciso retornar hoje", "meus leads", "abre o CRM", "retorna pro <nome>", "adia o <nome> para <data>", "o <nome> demonstrou interesse", "passei a proposta pro <nome>",
    "contas a pagar", "resumo do mês", "lança despesa <valor> <descrição>", "recebi <valor> de <descrição>", "fecha o mês", "ativa o agente <nome do agente>", "volta ao normal"];
  function montarPrompt(a) {
    const hojeExt = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const conversa = (a.historico || []).slice(-4).map((h) => `${h.quem === "voce" ? "Usuário" : "Jarvis"}: ${h.texto}`).join("\n");
    return [
      "Você é o Jarvis, assistente pessoal de voz de um(a) dono(a) de clínica odontológica no Brasil. Seja próximo, discreto e atento, com linguagem natural e sem intimidade forçada. Ajude a pensar e organizar uma coisa por vez. Não alegue conhecer a vida ou rotina além do contexto explicitamente fornecido.",
      `Hoje é ${hojeExt}.`,
      `Modo ativo: ${a.modo.nome}. ${a.modo.instrucao || ""}`,
      "REGRAS: responda em português do Brasil. Você NÃO executa nada: só informa, orienta e propõe. Nunca diga que enviou, pagou, agendou, publicou ou alterou algo. Não invente dados: use só o CONTEXTO; se faltar algo, diga o que falta. Não peça dados clínicos nem sensíveis de pacientes.",
      'FORMATO: responda SOMENTE um JSON {"fala": string, "titulo": string|null, "itens": string[]|null, "acoes": string[]|null}.',
      "- fala: no máximo 2 frases curtas para serem lidas em voz alta (sem listas, sem markdown, sem emojis).",
      "- titulo: título curto do que aparece na tela, ou null.",
      "- itens: até 8 linhas curtas com os detalhes. Se o pedido for para CRIAR texto (legenda, roteiro, mensagem, prompt), cada item é uma opção completa, pronta para copiar. null se não precisar.",
      "- acoes: até 4 comandos que o usuário pode dizer em seguida, escolhidos APENAS desta lista (troque <...> por valores reais do contexto): " + COMANDOS.join(" | ") + ". null se não houver.",
      "",
      "CONTEXTO:", a.contexto || "(sem dados)", "",
      conversa ? "CONVERSA RECENTE:\n" + conversa + "\n" : "",
      "PEDIDO DO USUÁRIO: " + a.texto,
    ].join("\n");
  }
  function limparResposta(r) {
    if (typeof r === "string") r = { fala: r };
    if (!r || typeof r !== "object") return null;
    const arr = (x, n, max) => (Array.isArray(x) ? x.map((i) => String(i == null ? "" : i).trim().slice(0, max)).filter(Boolean).slice(0, n) : []);
    const fala = String(r.fala || "").trim().slice(0, 500);
    if (!fala) return null;
    return { fala, titulo: r.titulo ? String(r.titulo).trim().slice(0, 80) : null, itens: arr(r.itens, 8, 600), acoes: arr(r.acoes, 4, 70) };
  }
  // Devolve { fala, titulo, itens, acoes } | { erro: "indisponivel"|"limite"|"falha" } | null (sem Claude aqui)
  async function perguntarClaude(a) {
    const s = await obterAmostra();
    if (!s) return null;
    try { return limparResposta(await s.json(montarPrompt(a), { modelTier: "quick", cache: false })) || { erro: "falha" }; }
    catch (e) {
      const c = e && e.code;
      if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(c)) { amostra = null; return { erro: "indisponivel" }; }
      if (c === "rate_limited") return { erro: "limite" };
      if (c === "invalid_json" && e.text) return limparResposta({ fala: String(e.text).replace(/[{}"]/g, "").slice(0, 400) }) || { erro: "falha" };
      return { erro: "falha" };
    }
  }

  window.JarvisBrain = {
    norm,
    chamou,
    interpretar,
    acharContato,
    linkWhatsapp,
    perguntarClaude,
    montarPrompt,
  };
})();
