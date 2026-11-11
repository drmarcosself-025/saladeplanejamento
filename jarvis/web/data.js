// Fonte de dados dos modos.
//
// HOJE: devolve dados de DEMONSTRAÇÃO (fictícios) para a interface funcionar
// sem backend. Nomes de pacientes aqui são inventados de propósito.
// DEPOIS: se APP_CONFIG.DATA_URL estiver preenchido, busca do backend
// (Edge Function `jarvis-data`), que conversa com Clinicorp, Gmail, Ads etc.
// O formato devolvido é o mesmo — a interface não muda.
(function () {
  const brl = (v) => "R$ " + v.toFixed(2).replace(".", ",");

  function demo(modeId) {
    switch (modeId) {
      case "trafego": {
        const gasto = 103.35, conv = 39, gasto7 = 861.5, receita = 195;
        return {
          gasto_ontem_fmt: brl(gasto), gasto_7d_fmt: brl(gasto7),
          conversas_ontem: conv, cpl_fmt: brl(gasto / conv),
          campanhas_ativas: 5, vendas_semana: 1, receita_semana_fmt: brl(receita),
          // gasto diário dos últimos 7 dias; soma = gasto_7d e o último = gasto de ontem
          serie: { rotulo: "Gasto por dia (7 dias)", valores: [118.4, 131.2, 109.75, 142.3, 127.1, 129.4, 103.35] },
        };
      }
      case "social":
        return {
          posts_hoje: 10, posts_ok: 8, aguardando_aprovacao: 0, erros_3d: 11,
          serie: { rotulo: "Posts por dia (7 dias)", valores: [6, 8, 7, 9, 10, 9, 10] },
        };
      case "gestao": {
        const contas = [
          { quem: "Energia", valor: 412.9, vence: "qui" },
          { quem: "Internet", valor: 189.9, vence: "sex" },
        ];
        return {
          pacientes: [
            { hora: "08:00", nome: "Paciente A", proc: "Avaliação", confirmado: true },
            { hora: "09:00", nome: "Paciente B", proc: "Limpeza", confirmado: false },
            { hora: "10:30", nome: "Paciente C", proc: "Clareamento", confirmado: false },
            { hora: "14:00", nome: "Paciente D", proc: "Retorno ortodontia", confirmado: true },
            { hora: "15:00", nome: "Paciente E", proc: "Avaliação", confirmado: false },
            { hora: "16:30", nome: "Paciente F", proc: "Restauração", confirmado: false },
          ],
          emails: [
            { de: "Fornecedor X", assunto: "Orçamento resina" },
            { de: "Contador", assunto: "Documentos de novembro" },
            { de: "Paciente", assunto: "Dúvida sobre pagamento" },
          ],
          contas,
          total_contas_fmt: brl(contas.reduce((s, c) => s + c.valor, 0)),
          serie: { rotulo: "Consultas nos próximos 7 dias", valores: [6, 7, 5, 8, 6, 4, 3] },
        };
      }
      case "programador":
        return { ultimo_projeto: "projeto-jarvis" };
      case "leads":   // dados reais do usuário (não são demonstração)
        return window.JarvisLeads ? window.JarvisLeads.resumo(window.JarvisLeads.lista()) : {};
      default:
        return {};
    }
  }

  window.JarvisData = {
    // Devolve { source: "demo" | "live", ...dados }
    async get(modeId) {
      if (modeId === "leads") return { source: "seus", ...demo(modeId) };
      const url = window.APP_CONFIG && window.APP_CONFIG.DATA_URL;
      if (url) {
        try {
          const r = await fetch(`${url}?mode=${encodeURIComponent(modeId)}`, {
            headers: { Authorization: `Bearer ${window.APP_CONFIG.JARVIS_TOKEN || ""}` },
          });
          if (r.ok) return { source: "live", ...(await r.json()) };
        } catch (_) { /* cai para demo e deixa isso visível na tela */ }
      }
      return { source: "demo", ...demo(modeId) };
    },
  };
})();
