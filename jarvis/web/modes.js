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
    status: "demo",
    resumo: "Posts na agenda, aprovação, erros de envio e criação de artes.",
    ferramentas: [
      { id: "social.agenda", nivel: "READ", desc: "Posts agendados, postados e com erro" },
      { id: "social.criar_arte", nivel: "PROPOSE", desc: "Gerar imagem/legenda para aprovação" },
      { id: "social.publicar", nivel: "EXECUTE", desc: "Publicar nas redes e grupos" },
    ],
    kpis: (d) => [
      ["Posts hoje", String(d.posts_hoje)],
      ["Já postados/agendados", String(d.posts_ok)],
      ["Aguardando aprovação", String(d.aguardando_aprovacao)],
      ["Erros de envio (3d)", String(d.erros_3d)],
    ],
    abertura: (d) =>
      `Modo Social Media ativado. ${d.aguardando_aprovacao === 0 ? "Nenhum post esperando aprovação" : d.aguardando_aprovacao + " posts esperando aprovação"}. Hoje são ${d.posts_hoje} posts na agenda, ${d.posts_ok} já agendados ou postados. ${d.erros_3d} posts dos últimos 3 dias deram erro no envio. Quer criar uma arte nova?`,
  },

  gestao: {
    id: "gestao",
    nome: "Gestão do Dia",
    cor: "#ffd23f",
    aliases: ["gestao do dia", "gestao", "secretaria", "meu dia", "rotina", "ceo"],
    status: "demo",
    resumo: "Confirmações da agenda de amanhã, e-mails que pedem resposta e contas a vencer.",
    ferramentas: [
      { id: "agenda.amanha", nivel: "READ", desc: "Agenda de amanhã (Clinicorp) com status de confirmação" },
      { id: "agenda.preparar_confirmacoes", nivel: "PROPOSE", desc: "Montar mensagem de confirmação por paciente" },
      { id: "whatsapp.enviar", nivel: "EXECUTE", desc: "Enviar a confirmação (só após aprovação)" },
      { id: "gmail.triagem", nivel: "READ", desc: "E-mails que pedem resposta" },
      { id: "gmail.rascunho", nivel: "PROPOSE", desc: "Rascunho de resposta" },
      { id: "financeiro.a_vencer", nivel: "READ", desc: "Boletos e contas a vencer (extraídos do e-mail)" },
    ],
    kpis: (d) => [
      ["Pacientes amanhã", String(d.pacientes.length)],
      ["Sem confirmação", String(d.pacientes.filter((p) => !p.confirmado).length)],
      ["E-mails p/ responder", String(d.emails.length)],
      ["Contas na semana", String(d.contas.length)],
      ["Total a pagar", d.total_contas_fmt],
    ],
    abertura: (d) => {
      const sem = d.pacientes.filter((p) => !p.confirmado).length;
      return `Modo Gestão do Dia ativado. Amanhã você tem ${d.pacientes.length} pacientes, ${sem} ainda sem confirmação. Tem ${d.emails.length} e-mails que pedem resposta e ${d.contas.length} contas vencendo nesta semana, ${d.total_contas_fmt} no total. Quer começar pelas confirmações?`;
    },
  },

  whatsapp: {
    id: "whatsapp",
    nome: "WhatsApp",
    cor: "#19e6c1",
    aliases: ["whatsapp", "zap", "leads", "atendimento"],
    status: "planejado",
    resumo: "Leads novos, conversas quentes e respostas aguardando aprovação (projeto dental-leads).",
    ferramentas: [
      { id: "leads.funil", nivel: "READ", desc: "Funil e temperatura dos leads (schema dental_leads)" },
      { id: "leads.rascunho", nivel: "PROPOSE", desc: "Sugerir resposta para lead" },
      { id: "whatsapp.enviar", nivel: "EXECUTE", desc: "Enviar (sempre por Evolution, com política e rate limit)" },
    ],
    kpis: () => [["Fonte", "dental-leads (a ligar)"]],
    abertura: () => "Modo WhatsApp ativado. Ainda não está ligado aos leads. Esta é a próxima integração planejada.",
  },

  video: {
    id: "video",
    nome: "Editor de Vídeo",
    cor: "#ff4d5e",
    aliases: ["editor de video", "video", "reels", "edicao"],
    status: "planejado",
    resumo: "Plano de cortes, legenda de tela e capa para Reels.",
    ferramentas: [{ id: "video.plano_cortes", nivel: "PROPOSE", desc: "Analisar vídeo e propor edição" }],
    kpis: () => [["Fonte", "a definir"]],
    abertura: () => "Modo Editor de Vídeo ativado. Ainda não tem integração. Está no planejamento.",
  },

  automacao: {
    id: "automacao",
    nome: "Assistente de Automação",
    cor: "#9a6bff",
    aliases: ["assistente de automacao", "automacao", "automatizar"],
    status: "planejado",
    resumo: "Cria e acompanha automações e fluxos entre os sistemas.",
    ferramentas: [{ id: "automacao.listar", nivel: "READ", desc: "Fluxos ativos e falhas recentes" }],
    kpis: () => [["Fonte", "a definir"]],
    abertura: () => "Modo Automação ativado. Ainda não tem integração. Está no planejamento.",
  },

  programador: {
    id: "programador",
    nome: "Programador",
    cor: "#2bff88",
    aliases: ["programador", "programar", "codigo", "dev", "claude code"],
    status: "planejado",
    resumo: "Abre projetos no Cursor, VS Code ou Claude Code no seu computador.",
    ferramentas: [
      { id: "dev.projetos", nivel: "READ", desc: "Lista de projetos e último projeto aberto (agente local no PC)" },
      { id: "dev.abrir", nivel: "EXECUTE", desc: "Abrir projeto / iniciar Claude Code" },
    ],
    kpis: (d) => [["Último projeto", d.ultimo_projeto || "—"]],
    abertura: (d) =>
      `Modo Programador ativado. O último projeto foi ${d.ultimo_projeto}. Em qual projeto vamos trabalhar?`,
  },
};

// Ordem em que os atalhos aparecem na barra superior.
window.JARVIS_ORDEM = ["gestao", "trafego", "social", "whatsapp", "video", "automacao", "programador"];
