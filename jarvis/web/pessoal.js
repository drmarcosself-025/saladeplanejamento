// Contexto pessoal explícito. Só neste navegador; não amplia as regras db do artefato.
(function () {
  const KEY = "jarvis_pessoal_v3", MAX_TASKS = 100;
  const limpar = (v, max) => String(v || "").replace(/\u0000/g, "").trim().slice(0, max);
  const vazio = () => ({ perfil: { nome: "Marcos", tom: "direto e acolhedor", foco: "", rotina: "", contexto: "", compartilhar: false }, tarefas: [] });
  function validar(raw) {
    const d = vazio(), p = raw && raw.perfil || {};
    for (const k of ["nome", "tom", "foco", "rotina", "contexto"]) d.perfil[k] = limpar(p[k], k === "nome" ? 40 : k === "foco" ? 160 : 800) || d.perfil[k];
    d.perfil.compartilhar = p.compartilhar === true;
    d.tarefas = (Array.isArray(raw && raw.tarefas) ? raw.tarefas : []).filter((t) => t && /^\d{4}-\d{2}-\d{2}$/.test(t.dia) && t.id && t.texto).slice(-MAX_TASKS).map((t) => ({ id: limpar(t.id, 60), texto: limpar(t.texto, 120), dia: t.dia, feita: t.feita === true }));
    return d;
  }
  let dados;
  try { dados = validar(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (_) { dados = vazio(); }
  const ler = () => JSON.parse(JSON.stringify(dados));
  function salvar(proximo) {
    const novo = validar(proximo);
    try { localStorage.setItem(KEY, JSON.stringify(novo)); dados = novo; return true; } catch (_) { return false; }
  }
  function contexto() {
    const p = dados.perfil;
    if (!p.compartilhar) return "O contexto pessoal não foi compartilhado. Não suponha que conhece a vida do usuário.";
    const hoje = window.JarvisLeads.iso(new Date());
    const tarefas = dados.tarefas.filter((t) => t.dia === hoje).map((t) => `${t.feita ? "Concluída" : "Pendente"}: ${t.texto}`).join("; ");
    return [`Como chamar: ${p.nome}. Tom preferido: ${p.tom}.`, p.foco && `Prioridade atual: ${p.foco}`, p.rotina && `Rotina informada pelo usuário: ${p.rotina}`, p.contexto && `Contexto informado pelo usuário: ${p.contexto}`, tarefas && `Prioridades de hoje: ${tarefas}`].filter(Boolean).join("\n");
  }
  window.JarvisPessoal = { ler, salvar, contexto, validar };
})();
