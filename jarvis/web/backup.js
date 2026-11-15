// Cópia portátil dos dados do usuário. O arquivo nunca é enviado ao Jarvis.
// A restauração soma itens ausentes; IDs existentes não são substituídos.
(function () {
  const KEY_CT = "jarvis_contatos_v1", FORMATO = "jarvis-backup-v1";
  const str = (v, max) => String(v == null ? "" : v).replace(/\u0000/g, "").trim().slice(0, max);
  const data = (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
    const [a, m, d] = v.split("-").map(Number), date = new Date(Date.UTC(a, m - 1, d));
    return date.getUTCFullYear() === a && date.getUTCMonth() + 1 === m && date.getUTCDate() === d ? v : "";
  };
  const numero = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const pronto = () => window.JarvisLeads.pronto && window.JarvisFin.pronto;
  function contatos() { try { const d = JSON.parse(localStorage.getItem(KEY_CT) || "[]"); return Array.isArray(d) ? d : []; } catch (_) { return []; } }
  function gerar() {
    if (!pronto()) throw Error("Aguarde a confirmação do armazenamento para fazer um backup completo.");
    return {
      formato: FORMATO, criadoEm: new Date().toISOString(),
      origem: { leads: JarvisLeads.modo, financeiro: JarvisFin.modo },
      leads: JarvisLeads.lista(), financeiro: [...JarvisFin.lista(), ...JarvisFin.fechamentos(), ...JarvisFin.fixas()],
      contatos: contatos(), pessoal: JarvisPessoal.ler(),
    };
  }
  function validar(raw) {
    if (!raw || raw.formato !== FORMATO) throw Error("Este arquivo não é um backup do Jarvis compatível.");
    for (const k of ["leads", "financeiro", "contatos"]) if (!Array.isArray(raw[k]) || raw[k].length > 5000) throw Error("Arquivo incompleto ou grande demais para restaurar.");
    if (!raw.pessoal || typeof raw.pessoal !== "object" || Array.isArray(raw.pessoal)) throw Error("O contexto pessoal está ausente no arquivo.");
    const leads = raw.leads.map((l) => {
      if (!l || !/^\d{10,15}$/.test(l.id) || !str(l.nome, 60) || JarvisContatos.normalizarTel(l.tel).tel !== l.id) throw Error("Um lead do arquivo tem dados inválidos.");
      const etapa = JarvisLeads.ETAPAS.some((e) => e.id === l.etapa) ? l.etapa : "novo";
      return JarvisLeads.garantirRegra(JarvisLeads.migrar({
        id: l.id, tel: str(l.tel, 24), nome: str(l.nome, 60), origem: str(l.origem, 40),
        interesse: str(l.interesse, 80), etapa, proximo: data(l.proximo),
        criado: str(l.criado, 35), atualizado: str(l.atualizado, 35), ultimoContato: data(l.ultimoContato),
        notas: str(l.notas, 300), valor: numero(l.valor) > 0 ? numero(l.valor) : null,
        historico: Array.isArray(l.historico) ? l.historico.slice(-40).map((h) => ({ ts: str(h && h.ts, 35), texto: str(h && h.texto, 300) })) : [],
      }));
    });
    const financeiro = raw.financeiro.map((f) => {
      if (!f || !/^[a-zA-Z0-9_-]{2,65}$/.test(f.id)) throw Error("Um lançamento do arquivo tem identificador inválido.");
      if (f.tipo === "fechamento") {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.mes) || f.id !== "f" + f.mes) throw Error("Um fechamento do arquivo é inválido.");
        return { id: f.id, tipo: "fechamento", mes: f.mes, receitas: numero(f.receitas), despesas: numero(f.despesas), saldo: numero(f.saldo), aPagar: numero(f.aPagar), aReceber: numero(f.aReceber), qtd: numero(f.qtd), fechadoEm: str(f.fechadoEm, 35) };
      }
      if (f.tipo === "fixa") {
        if (!(numero(f.valor) > 0) || !str(f.descricao, 100) || !Number.isInteger(f.dia) || f.dia < 1 || f.dia > 31) throw Error("Uma despesa fixa do arquivo é inválida.");
        return { id: f.id, tipo: "fixa", valor: f.valor, descricao: str(f.descricao, 100), categoria: str(f.categoria, 60) || JarvisFin.categorizar(f.descricao, "despesa"), dia: f.dia, ativa: f.ativa !== false, criado: str(f.criado, 35) };
      }
      if (!["receita", "despesa"].includes(f.tipo) || !(numero(f.valor) > 0) || !data(f.data)) throw Error("Um lançamento do arquivo tem dados inválidos.");
      return { id: f.id, tipo: f.tipo, valor: f.valor, descricao: str(f.descricao, 100), categoria: str(f.categoria, 60) || JarvisFin.categorizar(f.descricao, f.tipo), data: f.data, status: f.status === "pendente" ? "pendente" : "pago", vencimento: data(f.vencimento), criado: str(f.criado, 35), dataOriginal: data(f.dataOriginal), pagoEm: data(f.pagoEm), fixa: /^[a-zA-Z0-9_-]{2,65}$/.test(f.fixa) ? f.fixa : "" };
    });
    const contatos = raw.contatos.map((c) => {
      const tel = JarvisContatos.normalizarTel(c && c.tel);
      if (!tel.tel || !str(c.nome, 60)) throw Error("Um contato do arquivo tem dados inválidos.");
      return { nome: str(c.nome, 60), tel: JarvisContatos.formatarTel(tel.tel) };
    });
    return { leads, financeiro, contatos, pessoal: JarvisPessoal.validar(raw.pessoal) };
  }
  async function restaurar(d) {
    if (!pronto()) throw Error("Aguarde a confirmação do armazenamento antes de restaurar.");
    const v = validar(d), resultado = { leads: 0, financeiro: 0, contatos: 0, pessoal: false, falhas: 0 };
    for (const l of v.leads) if (!JarvisLeads.porId(l.id)) { if (await JarvisLeads.salvar(l)) resultado.leads++; else resultado.falhas++; }
    for (const f of v.financeiro) if (!JarvisFin.porId(f.id)) { if (await JarvisFin.salvar(f)) resultado.financeiro++; else resultado.falhas++; }
    const atuais = contatos(), mesclados = JarvisContatos.mesclar(atuais, v.contatos);
    if (mesclados.lista.length !== atuais.length) {
      try { localStorage.setItem(KEY_CT, JSON.stringify(mesclados.lista)); resultado.contatos = mesclados.lista.length - atuais.length; }
      catch (_) { resultado.falhas++; }
    }
    const atual = JarvisPessoal.ler(), ids = new Set(atual.tarefas.map((t) => t.id));
    const novas = v.pessoal.tarefas.filter((t) => !ids.has(t.id)), vagas = Math.max(0, 100 - atual.tarefas.length);
    atual.tarefas.push(...novas.slice(0, vagas));
    resultado.tarefas = Math.min(novas.length, vagas);
    resultado.ignoradas = Math.max(0, novas.length - vagas);
    atual.perfil = v.pessoal.perfil;
    // Compartilhar com o Claude é uma escolha deste aparelho, nunca herdada de um arquivo.
    atual.perfil.compartilhar = false;
    resultado.pessoal = JarvisPessoal.salvar(atual);
    if (!resultado.pessoal) resultado.falhas++;
    return resultado;
  }
  window.JarvisBackup = { gerar, validar, restaurar, pronto };
})();
