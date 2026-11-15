// Social Media: comentários a responder, calendário de posts e métricas importadas do Meta Business Suite.
// NÃO há conexão com o Instagram (a API oficial exige um servidor): você anota/cola o que precisa e o Jarvis organiza e lembra.
(function () {
  const KEY = "jarvis_social_v1", MAX = 300;
  const FORMATOS = ["Reels", "Carrossel", "Stories", "Foto"], STATUS = [["ideia", "Ideia"], ["roteiro", "Roteiro"], ["pronto", "Pronto"], ["postado", "Postado"]];
  const rx = /^\d{4}-\d{2}-\d{2}$/;
  const limpar = (v, max) => String(v == null ? "" : v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const vazio = () => ({ posts: [], comentarios: [], metricas: [] });
  function validar(raw) {
    const d = vazio(); if (!raw || typeof raw !== "object") return d;
    d.posts = (Array.isArray(raw.posts) ? raw.posts : []).filter((p) => p && p.id && p.tema && rx.test(p.data)).slice(-MAX)
      .map((p) => ({ id: limpar(p.id, 60), tema: limpar(p.tema, 140), data: p.data, formato: FORMATOS.includes(p.formato) ? p.formato : "Foto", status: STATUS.some((s) => s[0] === p.status) ? p.status : "ideia" }));
    d.comentarios = (Array.isArray(raw.comentarios) ? raw.comentarios : []).filter((c) => c && c.id && c.texto).slice(-MAX)
      .map((c) => ({ id: limpar(c.id, 60), autor: limpar(c.autor, 60) || "Alguém", texto: limpar(c.texto, 400), post: limpar(c.post, 80), status: c.status === "respondido" ? "respondido" : "pendente", criado: limpar(c.criado, 35) }));
    d.metricas = (Array.isArray(raw.metricas) ? raw.metricas : []).slice(0, 200).map((m) => ({ titulo: limpar(m.titulo, 120), data: rx.test(m.data) ? m.data : "", alcance: +m.alcance || 0, curtidas: +m.curtidas || 0, comentarios: +m.comentarios || 0, compart: +m.compart || 0, salvos: +m.salvos || 0 }));
    return d;
  }
  let dados, ouvintes = [];
  try { dados = validar(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (_) { dados = vazio(); }
  const ler = () => JSON.parse(JSON.stringify(dados));
  function salvar(proximo) {
    const novo = validar(proximo);
    try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(novo)); dados = novo; ouvintes.forEach((f) => { try { f(); } catch (_) {} }); return true; } catch (_) { return false; }
  }
  const aoMudar = (f) => ouvintes.push(f);
  const id = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  function novoPost(d, hoje) {
    const tema = limpar(d.tema, 140); if (!tema) return { erro: "tema" };
    return { id: id("p"), tema, data: rx.test(d.data) ? d.data : hoje, formato: FORMATOS.includes(d.formato) ? d.formato : "Foto", status: "ideia" };
  }
  function novoComentario(d, agora) {
    const texto = limpar(d.texto, 400); if (!texto) return { erro: "texto" };
    return { id: id("c"), autor: limpar(String(d.autor || "").replace(/^@/, ""), 60) || "Alguém", texto, post: limpar(d.post, 80), status: "pendente", criado: (agora || new Date()).toISOString() };
  }
  const pendentes = (d) => d.comentarios.filter((c) => c.status === "pendente");
  const postsDoDia = (d, dia) => d.posts.filter((p) => p.data === dia && p.status !== "postado");
  const atrasados = (d, hoje) => d.posts.filter((p) => p.data < hoje && p.status !== "postado");
  function resumo(d, hoje, fimSemana) {
    return { pendentes: pendentes(d).length, hoje: postsDoDia(d, hoje).length, atrasados: atrasados(d, hoje).length,
      semana: d.posts.filter((p) => p.data >= hoje && p.data <= (fimSemana || hoje) && p.status !== "postado").length, postados: d.posts.filter((p) => p.status === "postado").length };
  }
  // Acha o comentário pelo autor (parte do nome) entre os pendentes.
  const achar = (d, nome) => { const q = norm(nome).replace(/^@/, ""); return pendentes(d).filter((c) => norm(c.autor).includes(q)); };

  // Respostas prontas (sem Claude): tom acolhedor, sem preço e sem promessa clínica.
  function respostasLocais(c) {
    const n = c.autor.split(" ")[0], t = norm(c.texto);
    if (/(quanto|valor|preco|custa|orcamento|investimento)/.test(t)) return [`Oi, ${n}! O valor depende da sua avaliação, que é individual. Te chamei no direct para combinar um horário. 💙`, `${n}, obrigada pelo interesse! Cada caso é único, então prefiro te explicar com calma no direct. Já te mando uma mensagem.`, `Oi, ${n}! Posso te passar os detalhes pelo WhatsApp? Me chama no direct que eu te atendo com carinho.`];
    if (/(dor|doi|sensib|inflam|sangr)/.test(t)) return [`${n}, sinto muito por isso. O ideal é uma avaliação para entender o que está acontecendo. Te chamei no direct para agendarmos.`, `Oi, ${n}! Isso merece atenção profissional. Me chama no direct que encontramos o melhor horário para te ver.`, `${n}, obrigada por contar! Vamos cuidar disso com calma: te mandei uma mensagem no direct.`];
    if (/(onde|endereco|localiza|cidade|atende)/.test(t)) return [`Oi, ${n}! Te mandei o endereço e os horários no direct. 💙`, `${n}, obrigada por perguntar! Já te chamei no direct com a localização.`, `Oi, ${n}! Me chama no direct que passo o endereço e os horários de atendimento.`];
    if (/(lindo|amei|incrivel|perfeit|parabens|maravilh|top)/.test(t)) return [`Obrigada, ${n}! Que carinho! 💙`, `${n}, que bom que gostou! Fico muito feliz com o seu comentário.`, `Muito obrigada, ${n}! Seu carinho faz toda a diferença.`];
    return [`Oi, ${n}! Obrigada pelo seu comentário. 💙`, `${n}, obrigada por interagir! Se quiser conversar mais, me chama no direct.`, `Oi, ${n}! Que bom ter você por aqui. Qualquer dúvida, é só chamar no direct.`];
  }

  // ---------- métricas do Meta Business Suite (CSV exportado) ----------
  function lerMetricas(linhas) {
    if (!linhas || linhas.length < 2) return { erro: "O arquivo está vazio." };
    const cab = linhas[0].map(norm), col = (re) => cab.findIndex((h) => re.test(h));
    const ic = { titulo: col(/(titulo|descricao|legenda|post|publicacao|title|description)/), data: col(/(data|date|publicado|hora de publicacao)/), alcance: col(/(alcance|reach|contas alcancadas)/), curtidas: col(/(curtida|reacoes|likes)/), comentarios: col(/(comentario|comments)/), compart: col(/(compartilh|shares)/), salvos: col(/(salvamento|salvos|saves)/) };
    if (ic.alcance < 0 && ic.curtidas < 0) return { erro: "Não achei colunas de alcance ou curtidas. Exporte as métricas de publicações no Meta Business Suite." };
    const num = (v) => { const n = parseFloat(String(v || "0").replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
    const dt = (v) => { const m = String(v || "").match(/(\d{4})-(\d{2})-(\d{2})/) || String(v || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); if (!m) return ""; return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`; };
    const posts = linhas.slice(1).map((r) => ({ titulo: limpar(ic.titulo >= 0 ? r[ic.titulo] : "Publicação", 120) || "Publicação", data: dt(ic.data >= 0 ? r[ic.data] : ""), alcance: num(r[ic.alcance]), curtidas: num(r[ic.curtidas]), comentarios: num(r[ic.comentarios]), compart: num(r[ic.compart]), salvos: num(r[ic.salvos]) }))
      .filter((p) => p.alcance || p.curtidas || p.comentarios);
    return posts.length ? { posts } : { erro: "Nenhuma publicação com números nesse arquivo." };
  }
  const pontos = (p) => p.curtidas + 3 * p.comentarios + 3 * p.compart + 3 * p.salvos;
  const melhores = (ms, n) => ms.slice().sort((a, b) => pontos(b) - pontos(a)).slice(0, n || 5);

  window.JarvisSocial = { FORMATOS, STATUS, ler, salvar, aoMudar, validar, novoPost, novoComentario, pendentes, postsDoDia, atrasados, resumo, achar, respostasLocais, lerMetricas, pontos, melhores };
})();
