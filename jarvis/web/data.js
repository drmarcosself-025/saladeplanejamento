// Fonte de dados dos modos.
//
// Agenda, e-mails, tráfego e social são demonstração. Contas vêm do financeiro
// registrado pelo usuário no artefato ou neste navegador.
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
        const contas = window.JarvisFin ? window.JarvisFin.pendentes(window.JarvisFin.lista(), new Date(), 7)
          .map((l) => ({ id: l.id, quem: l.descricao || l.categoria, valor: l.valor, vence: l.vencimento || l.data })) : [];
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
      case "contador": {
        const F = window.JarvisFin, mes = F.mesDe(window.JarvisLeads.iso(new Date()));
        const r = F.resumoMes(F.lista(), mes);
        return { ...r, receitas_fmt: brl(r.receitas), despesas_fmt: brl(r.despesas), saldo_fmt: brl(r.saldo), aPagar_fmt: brl(r.aPagar), aReceber_fmt: brl(r.aReceber) };
      }
      case "leads":   // dados reais do usuário (não são demonstração)
        return window.JarvisLeads ? window.JarvisLeads.resumo(window.JarvisLeads.lista()) : {};
      default:
        return {};
    }
  }

  window.JarvisData = {
    // Devolve { source: "demo" | "misto" | "seus", ...dados }.
    async get(modeId) {
      if (modeId === "leads" || modeId === "contador") return { source: "seus", ...demo(modeId) };
      if (modeId === "designer" || modeId === "programador") return { source: "criacao", ...demo(modeId) };
      if (modeId === "gestao") return { source: "misto", ...demo(modeId) };
      return { source: "demo", ...demo(modeId) };
    },
  };
})();
