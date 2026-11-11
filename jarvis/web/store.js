// Armazenamento genérico de coleções (leads, financeiro...).
//   - dentro do claude.ai: capacidade `db` (um documento por item; sincroniza
//     iPhone e computador; só o dono lê/grava, conforme as regras publicadas);
//   - fora dele, ou sem `db`: localStorage deste navegador.
// Cada coleção tem sua própria instância. Itens precisam de `id` (string).
(function () {
  function criar(cfg) {
    const S = { modo: "local", db: null, itens: [], ouvintes: [], aviso: "", confirmado: false, timer: 0, filas: {} };
    const norm = cfg.normalizar || ((x) => x);
    const avisar = () => S.ouvintes.forEach((f) => { try { f(); } catch (_) {} });

    function msgErro(e) {
      const c = e && e.code;
      if (c === "quota_exceeded") return "O armazenamento do claude.ai está cheio. Apague itens antigos.";
      if (c === "resource_exhausted") return "Muitas alterações seguidas. Espere um instante e tente de novo.";
      if (c === "invalid_argument") return "Só o dono do artefato pode gravar estes dados.";
      if (c === "revoked" || c === "not_granted") return "Sem acesso ao armazenamento do claude.ai nesta sessão.";
      return "Não consegui salvar agora. Tente de novo.";
    }
    const lerLocal = () => { try { return JSON.parse(localStorage.getItem(cfg.chaveLocal) || "[]").map(norm); } catch (_) { return []; } };
    const gravarLocal = () => { try { localStorage.setItem(cfg.chaveLocal, JSON.stringify(S.itens)); return true; } catch (_) { S.aviso = "Não coube no armazenamento do navegador."; return false; } };
    // Uma gravação por vez em cada documento (exigência do armazenamento).
    const enfileirar = (id, fn) => { const p = (S.filas[id] || Promise.resolve()).then(fn, fn); S.filas[id] = p.catch(() => {}); return p; };

    async function iniciar() {
      let db = null;
      try { if (window.claude && typeof window.claude.use === "function") db = await window.claude.use("db"); } catch (_) { db = null; }
      if (!db) { S.modo = "local"; S.itens = lerLocal(); avisar(); return S.modo; }
      S.modo = "claude"; S.db = db;
      S.timer = setTimeout(() => { if (!S.confirmado) { S.aviso = "Ainda não consegui alcançar o armazenamento do claude.ai. Os dados podem estar desatualizados."; avisar(); } }, 10000);
      db.collection(cfg.colecao).onSnapshot((snap) => {
        S.itens = snap.docs.map((d) => norm({ id: d.id, ...d.data() }));
        if (!snap.metadata.fromCache) { S.confirmado = true; clearTimeout(S.timer); S.aviso = ""; }
        avisar();
      }, (e) => { S.aviso = msgErro(e); avisar(); });
      return S.modo;
    }
    async function salvar(item) {
      const { id, ...corpo } = item;
      if (S.modo === "claude") {
        try { await enfileirar(id, () => S.db.doc(cfg.colecao + "/" + id).set(corpo)); S.aviso = ""; return true; }
        catch (e) { S.aviso = msgErro(e); avisar(); return false; }
      }
      const i = S.itens.findIndex((x) => x.id === id);
      if (i >= 0) S.itens[i] = item; else S.itens.push(item);
      const ok = gravarLocal(); avisar(); return ok;
    }
    async function remover(id) {
      if (S.modo === "claude") {
        try { await enfileirar(id, () => S.db.doc(cfg.colecao + "/" + id).delete()); return true; }
        catch (e) { S.aviso = msgErro(e); avisar(); return false; }
      }
      S.itens = S.itens.filter((x) => x.id !== id); gravarLocal(); avisar(); return true;
    }
    return {
      iniciar, salvar, remover,
      lista: () => S.itens.slice(),
      porId: (id) => S.itens.find((x) => x.id === id) || null,
      aoMudar: (f) => S.ouvintes.push(f),
      get modo() { return S.modo; },
      get aviso() { return S.aviso; },
    };
  }
  window.JarvisStore = { criar };
})();
