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
      case "social": {   // dados reais registrados pelo usuário
        const S = window.JarvisSocial, L = window.JarvisLeads, hoje = L.iso(new Date()), r = S.resumo(S.ler(), hoje, L.somar(hoje, 6));
        return { ...r, serie: { rotulo: "Posts planejados nos próximos 7 dias", valores: Array.from({ length: 7 }, (_, i) => S.ler().posts.filter((p) => p.data === L.somar(hoje, i)).length) } };
      }
      case "gestao": {   // dados reais: rotina, prioridades, leads e contas do usuário
        const R = window.JarvisRotina, agora = new Date(), c = R.montarDia(agora), sem = R.montarSemana(agora);
        return { ...c, resumo: R.resumoDia(c), serie: { rotulo: "Compromissos nesta semana", valores: sem.dias.map((d) => d.compromissos.length) } };
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
      if (modeId === "gestao" || modeId === "social") return { source: "seus", ...demo(modeId) };
      return { source: "demo", ...demo(modeId) };
    },
  };
})();
