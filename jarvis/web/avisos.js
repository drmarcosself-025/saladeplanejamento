// Central de avisos: junta o que está pendente em leads, contas, rotina, redes sociais e relacionamento (CRC).
(function () {
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
  const ORDEM = { alta: 0, media: 1, info: 2 };
  // c = { hoje, hora, leadsAtrasados, retornosHoje, contasAtrasadas, contasVencendo[{descricao,vencimento}], compromissos[{titulo,hora,feito}],
  //       comentarios, postsHoje, postsAtrasados, tarefas, agua, meta, clientesParados }
  function montar(c) {
    const it = [], add = (area, nivel, texto, cmd) => it.push({ area, nivel, texto, cmd });
    if (c.leadsAtrasados) add("leads", "alta", `${plural(c.leadsAtrasados, "retorno de lead atrasado", "retornos de leads atrasados")}`, "quem preciso retornar hoje");
    if (c.contasAtrasadas) add("contas", "alta", `${plural(c.contasAtrasadas, "conta atrasada", "contas atrasadas")}`, "contas a pagar");
    if (c.postsAtrasados) add("social", "alta", `${plural(c.postsAtrasados, "post planejado que passou da data", "posts planejados que passaram da data")}`, "calendário de posts");
    const prox = c.compromissos.filter((x) => !x.feito && (!x.hora || +x.hora.slice(0, 2) >= c.hora)).sort((a, b) => (a.hora || "99").localeCompare(b.hora || "99"))[0];
    if (prox) add("rotina", "media", `Compromisso${prox.hora ? " às " + prox.hora.replace(/^0/, "").replace(":00", "h").replace(":", "h") : " hoje"}: ${prox.titulo}`, "resumo do dia");
    if (c.retornosHoje) add("leads", "media", `${plural(c.retornosHoje, "retorno de lead", "retornos de leads")} para hoje`, "quem preciso retornar hoje");
    for (const x of c.contasVencendo.slice(0, 2)) add("contas", "media", `Conta ${x.descricao} vence ${x.vencimento.slice(8)}/${x.vencimento.slice(5, 7)}`, "contas a pagar");
    if (c.comentarios) add("social", "media", `${plural(c.comentarios, "comentário esperando resposta", "comentários esperando resposta")}`, "quais comentários preciso responder");
    if (c.postsHoje) add("social", "media", `${plural(c.postsHoje, "post planejado para hoje", "posts planejados para hoje")}`, "calendário de posts");
    if (c.tarefas) add("rotina", "info", `${plural(c.tarefas, "prioridade pendente", "prioridades pendentes")}`, "resumo do dia");
    if (c.clientesParados) add("crc", "info", `${plural(c.clientesParados, "cliente sem contato há mais de 30 dias", "clientes sem contato há mais de 30 dias")}: bom momento para um “como você está?”`, "clientes para reativar");
    if (c.hora >= 14 && c.agua < Math.ceil(c.meta / 2)) add("rotina", "info", `Água: só ${c.agua} de ${c.meta} copos hoje`, "quanta água eu bebi");
    it.sort((a, b) => ORDEM[a.nivel] - ORDEM[b.nivel]);
    const urgentes = it.filter((x) => x.nivel !== "info");
    const fala = !it.length ? "Está tudo em dia. Nenhuma pendência agora."
      : `Você tem ${plural(it.length, "aviso", "avisos")}${urgentes.length ? `, ${urgentes.length} importante${urgentes.length > 1 ? "s" : ""}` : ""}. ${it.slice(0, 3).map((x) => x.texto).join(". ")}.`;
    return { itens: it, fala, total: it.length, urgentes: urgentes.length };
  }
  // Lê os módulos do app e monta o contexto.
  function coletar(agora) {
    const L = window.JarvisLeads, F = window.JarvisFin, R = window.JarvisRotina, S = window.JarvisSocial, hoje = L.iso(agora), r = L.resumo(L.lista()), pend = F.pendentes(F.lista(), agora, 3);
    const rot = R ? R.ler() : { compromissos: [], agua: {}, metaAgua: 8 }, soc = S ? S.ler() : { posts: [], comentarios: [] };
    const limite = L.somar(hoje, -30), tarefas = window.JarvisPessoal ? window.JarvisPessoal.ler().tarefas.filter((t) => t.dia === hoje && !t.feita).length : 0;
    const parados = L.lista().filter((l) => l.etapa === "fechou" && (l.ultimoContato || String(l.atualizado || "").slice(0, 10) || "9999") < limite);
    return { hoje, hora: agora.getHours(), leadsAtrasados: r.atrasados || 0, retornosHoje: (r.hoje || 0) + (r.semData || 0), contasAtrasadas: pend.filter((x) => x.atrasada).length,
      contasVencendo: pend.filter((x) => !x.atrasada).map((x) => ({ descricao: x.descricao || x.categoria, vencimento: x.vencimento || x.data })),
      compromissos: rot.compromissos.filter((x) => x.data === hoje), comentarios: S ? S.pendentes(soc).length : 0, postsHoje: S ? S.postsDoDia(soc, hoje).length : 0, postsAtrasados: S ? S.atrasados(soc, hoje).length : 0,
      tarefas, agua: rot.agua[hoje] || 0, meta: rot.metaAgua, clientesParados: parados.length, _parados: parados };
  }
  window.JarvisAvisos = { montar, coletar };
})();
