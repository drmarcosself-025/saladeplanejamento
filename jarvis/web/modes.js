// Registro de modos (agentes) do Jarvis.
//
// Cada modo é DADO, não código: nome, cor, apelidos de voz, o que fala ao
// ativar, o que mostra no painel e quais ferramentas pode usar. Criar um
// agente novo = adicionar uma entrada aqui (e, no futuro, a ferramenta
// correspondente no backend).
//
// Níveis de segurança de cada ferramenta (ver ARQUITETURA.md §5):
//   READ     só lê. Roda direto.
//   PROPOSE  prepara algo (rascunho, lista, mensagem) e MOSTRA. Não envia.
//   EXECUTE  altera/envia de verdade. Só roda depois de "Jarvis, confirma".
window.JARVIS_MODES = {
  normal: {
    id: "normal",
    nome: "Jarvis",
    cor: "#35b8ff",
    aliases: [],
    status: "ativo",
    resumo: "Modo neutro. Diga o nome de um agente para ativá-lo.",
    sugestoes: ["Ativa o agente dia a dia", "Abre o CRM", "Ativa o agente contador"],
    instrucao: "Ajude a organizar o trabalho do dia. Não invente dados nem execute ações.",
    ferramentas: [],
    kpis: () => [],
    abertura: () => "De volta ao normal.",
  },

  trafego: {
    id: "trafego",
    nome: "Gestor de Tráfego",
    cor: "#ff8a2a",
    aliases: ["gestor de trafego", "trafego", "gestor de anuncios", "anuncios"],
    status: "demo",
    resumo: "Campanhas, gasto, custo por conversa e vendas vindas dos anúncios.",
    instrucao: "Analise apenas dados fornecidos. Separe fatos de sugestões e nunca altere campanhas.",
    sugestoes: ["Analisa as campanhas", "Volta ao normal"],
    ferramentas: [
      { id: "ads.resumo", nivel: "READ", desc: "Gasto, conversas e custo por conversa (ontem / 7 dias)" },
      { id: "crm.vendas_origem", nivel: "READ", desc: "Vendas por origem no CRM" },
      { id: "ads.pausar_campanha", nivel: "EXECUTE", desc: "Pausar/retomar campanha" },
      { id: "ads.ajustar_orcamento", nivel: "EXECUTE", desc: "Alterar orçamento diário" },
    ],
    kpis: (d) => [
      ["Gasto ontem", d.gasto_ontem_fmt],
      ["Gasto 7 dias", d.gasto_7d_fmt],
      ["Conversas ontem", String(d.conversas_ontem)],
      ["Custo / conversa", d.cpl_fmt],
      ["Campanhas ativas", String(d.campanhas_ativas)],
      ["Vendas (7d)", `${d.vendas_semana} · ${d.receita_semana_fmt}`],
    ],
    abertura: (d) =>
      `Modo Gestor de Tráfego ativado. Ontem você investiu ${d.gasto_ontem_fmt} e teve ${d.conversas_ontem} conversas no WhatsApp, a ${d.cpl_fmt} cada. ${d.campanhas_ativas} campanhas ativas. Na semana, os anúncios trouxeram ${d.vendas_semana} venda no CRM, somando ${d.receita_semana_fmt}. Quer que eu analise?`,
  },

  social: {
    id: "social",
    nome: "Social Media",
    cor: "#ff3fbf",
    aliases: ["social media", "social", "redes sociais", "midia social"],
    status: "ativo",
    resumo: "Comentários a responder, calendário de posts e métricas do Meta Business Suite.",
    instrucao: "Crie textos sóbrios para a clínica, sem promessas clínicas, preço promocional ou publicação automática. O Instagram NÃO está conectado: trabalhe só com os comentários, posts e métricas que o usuário registrou; nunca invente seguidores, curtidas ou notificações.",
    sugestoes: ["Quais comentários preciso responder?", "Calendário de posts", "Agenda um reels sobre clareamento sexta", "Como está meu Instagram?"],
    ferramentas: [
      { id: "social.comentarios", nivel: "LOCAL", desc: "Fila de comentários a responder e respostas sugeridas" },
      { id: "social.calendario", nivel: "LOCAL", desc: "Calendário de posts (ideia, roteiro, pronto, postado)" },
      { id: "social.metricas", nivel: "READ", desc: "Métricas importadas do Meta Business Suite (CSV)" },
      { id: "instagram.api", nivel: "READ", desc: "Notificações e comentários ao vivo (planejado: exige servidor)" },
    ],
    kpis: (d) => [
      ["Comentários a responder", String(d.pendentes || 0)],
      ["Posts hoje", String(d.hoje || 0)],
      ["Posts atrasados", String(d.atrasados || 0)],
      ["Posts na semana", String(d.semana || 0)],
    ],
    abertura: (d) => `Modo Social Media ativado. ${d.pendentes ? d.pendentes + (d.pendentes === 1 ? " comentário espera" : " comentários esperam") + " resposta. " : "Nenhum comentário na fila. "}${d.hoje ? d.hoje + (d.hoje === 1 ? " post planejado para hoje." : " posts planejados para hoje.") : "Nenhum post planejado para hoje."}${d.atrasados ? " " + d.atrasados + " passou da data." : ""} O Instagram ainda não está conectado: você anota os comentários e eu organizo.`,
  },

  gestao: {
    id: "gestao",
    nome: "Dia a Dia",
    cor: "#ffd23f",
    aliases: ["dia a dia", "gestao do dia", "gestao", "secretaria", "meu dia", "rotina", "ceo"],
    status: "ativo",
    resumo: "Seu dia e sua semana: prioridades, compromissos, retornos de leads, contas, água e alimentação.",
    instrucao: "Organize o dia e a semana do usuário com base nos dados reais do CONTEXTO (prioridades, compromissos, leads, contas, água, refeições). Agenda da clínica (Clinicorp) e e-mails ainda NÃO estão conectados: nunca invente pacientes, horários nem mensagens.",
    sugestoes: ["Resumo do dia", "Como está minha semana?", "Bebi um copo de água", "Marca reunião amanhã às 14h"],
    ferramentas: [
      { id: "rotina.resumo", nivel: "READ", desc: "Resumo do dia e feedback da semana (prioridades, compromissos, leads, contas)" },
      { id: "rotina.registrar", nivel: "LOCAL", desc: "Registrar prioridade, compromisso, água e refeições neste navegador" },
      { id: "agenda.clinicorp", nivel: "READ", desc: "Agenda da clínica (planejado: ainda não conectado)" },
      { id: "gmail.triagem", nivel: "READ", desc: "E-mails e boletos (planejado: ainda não conectado)" },
    ],
    kpis: (d) => [
      ["Compromissos hoje", String((d.compromissos || []).length)],
      ["Prioridades pendentes", String((d.tarefas || []).filter((t) => !t.feita).length)],
      ["Retornos de leads", String((d.retornos || 0) + (d.atrasados || 0))],
      ["Contas na semana", String((d.contas || []).length)],
      ["Água hoje", `${d.agua || 0}/${d.meta || 8}`],
    ],
    abertura: (d) => `Modo Dia a Dia ativado. ${d.resumo ? d.resumo.fala : "Diga “resumo do dia” ou “como está minha semana”."}`,
  },

  leads: {
    id: "leads",
    nome: "Leads",
    cor: "#19e6c1",
    aliases: ["leads", "lead", "funil", "retornos", "atendimento", "whatsapp", "zap"],
    status: "ativo",
    resumo: "Quem chegou, em que etapa está e quando cobrar de novo. Nenhum lead fica sem data de retorno.",
    instrucao: "Use só dados mínimos dos leads. Sugira retornos curtos e humanos; não envie mensagens. Se faltar dado, pergunte.",
    sugestoes: ["Quem preciso retornar hoje?", "Meus leads", "Volta ao normal"],
    ferramentas: [
      { id: "leads.listar", nivel: "READ", desc: "Funil e retornos de hoje e atrasados" },
      { id: "leads.registrar", nivel: "LOCAL", desc: "Novo lead, etapa e data de retorno (grava na sua lista)" },
      { id: "leads.retorno", nivel: "PROPOSE", desc: "Preparar a mensagem de retorno" },
      { id: "whatsapp.abrir", nivel: "EXECUTE", desc: "Abrir o WhatsApp com a mensagem (você toca em enviar)" },
    ],
    kpis: (d) => [
      ["Retornar hoje", String(d.hoje || 0)],
      ["Atrasados", String(d.atrasados || 0)],
      ["Leads ativos", String(d.ativos || 0)],
      ["Sem data de retorno", String(d.semData || 0)],
      ["Fechados", String(d.fechados || 0)],
      ["Sem interesse", String(d.semInteresse || 0)],
    ],
    abertura: (d) => {
      if (!d.total) return "Modo Leads ativado. Você ainda não tem leads. Diga: novo lead, o nome, o telefone, de onde veio e o que quer.";
      const devidos = (d.hoje || 0) + (d.atrasados || 0) + (d.semData || 0);
      if (!devidos) return `Modo Leads ativado. Nenhum retorno pendente agora. Você tem ${d.ativos} leads ativos no funil.`;
      return `Modo Leads ativado. Você tem ${devidos} ${devidos === 1 ? "lead para retornar" : "leads para retornar"}${d.atrasados ? `, ${d.atrasados} já atrasado${d.atrasados > 1 ? "s" : ""}` : ""}. ${d.ativos} ativos no funil. Quer que eu mostre quem?`;
    },
  },

  designer: {
    id: "designer",
    nome: "Designer",
    cor: "#ff4d5e",
    aliases: ["designer", "editor de video", "video", "reels", "edicao"],
    status: "ativo",
    resumo: "Legendas, roteiros de Reels, ideias de post e briefings de arte.",
    instrucao: "Crie legendas, roteiros, ideias e briefings copiáveis. Sem promessa de resultado, preço promocional, anúncio de gratuidade ou imagem identificável de paciente sem autorização. Se propuser antes/depois, sinalize que a divulgação exige revisão das regras do CFO, autoria do dentista, TCLE e identificação profissional. Não publique.",
    sugestoes: ["Ideia de post sobre alinhadores", "Roteiro de Reels", "Volta ao normal"],
    ferramentas: [{ id: "designer.rascunho", nivel: "PROPOSE", desc: "Preparar texto para copiar e revisar" }],
    kpis: () => [["Entrega", "Rascunhos"]],
    abertura: () => "Modo Designer ativado. Posso preparar legenda, roteiro, ideia de post ou briefing de arte para você revisar.",
  },

  contador: {
    id: "contador", nome: "Contador", cor: "#8fb6ff",
    aliases: ["contador", "financeiro", "financas", "caixa"], status: "ativo",
    resumo: "Receitas, despesas e contas lançadas por você. Nenhum pagamento é feito aqui.",
    instrucao: "Explique lançamentos do usuário com clareza. Pendente não compõe saldo pago. Nunca diga que uma conta foi paga sem registro confirmado.",
    sugestoes: ["Resumo financeiro do mês", "Quais contas tenho a pagar?", "Volta ao normal"],
    ferramentas: [{ id: "fin.listar", nivel: "READ", desc: "Consultar lançamentos" }, { id: "fin.lancar", nivel: "LOCAL", desc: "Gravar lançamento após informar valor" }, { id: "fin.relatorio", nivel: "PROPOSE", desc: "Preparar relatório copiável" }],
    kpis: (d) => [["Recebido", d.receitas_fmt || "R$ 0,00"], ["Pago", d.despesas_fmt || "R$ 0,00"], ["Saldo", d.saldo_fmt || "R$ 0,00"], ["A pagar", d.aPagar_fmt || "R$ 0,00"], ["A receber", d.aReceber_fmt || "R$ 0,00"]],
    abertura: (d) => `Modo Contador ativado. Neste mês, recebido ${d.receitas_fmt || "R$ 0,00"}, pago ${d.despesas_fmt || "R$ 0,00"}. A pagar ${d.aPagar_fmt || "R$ 0,00"}.`,
  },

  programador: {
    id: "programador",
    nome: "Programador",
    cor: "#2bff88",
    aliases: ["programador", "programar", "codigo", "dev", "claude code"],
    status: "ativo",
    resumo: "Transforma ideias em briefings e prompts copiáveis para o Claude Code.",
    instrucao: "Traduza a ideia em briefing, prompt para Claude Code e checklist copiáveis. Não alegue acesso ao computador, repositório ou execução local.",
    sugestoes: ["Faça um briefing para meu site", "Volta ao normal"],
    ferramentas: [{ id: "dev.briefing", nivel: "PROPOSE", desc: "Preparar briefing, prompt e checklist" }],
    kpis: () => [["Entrega", "Texto copiável"]],
    abertura: () => "Modo Programador ativado. Descreva uma ideia e preparo um briefing e um prompt para o Claude Code.",
  },
};

// Ordem em que os atalhos aparecem na barra superior.
window.JARVIS_ORDEM = ["gestao", "leads", "trafego", "social", "designer", "programador", "contador"];
