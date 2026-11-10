// Importação de contatos: vCard (.vcf) e CSV (Google Contatos, Clinicorp, planilhas).
// Tudo roda no navegador; o arquivo nunca sai do seu computador.
// Funções puras, testáveis em Node (ver tests/contacts.test.mjs).
(function () {
  // ---------- telefone ----------
  // Devolve só dígitos com DDI (55 para o Brasil) ou null se não der para usar no WhatsApp.
  // `tipo` informa o motivo da recusa quando for null: "fixo" | "invalido".
  function normalizarTel(raw) {
    const s = String(raw == null ? "" : raw).trim();
    let d = s.replace(/\D/g, "");
    if (!d) return { tel: null, motivo: "invalido" };
    const internacional = s.startsWith("+") || s.startsWith("00");
    if (s.startsWith("00")) d = d.slice(2);
    if (internacional && !d.startsWith("55")) {
      return d.length >= 10 && d.length <= 15 ? { tel: d } : { tel: null, motivo: "invalido" };
    }
    if (d.startsWith("0") && (d.length === 11 || d.length === 12)) d = d.slice(1);   // 0 63 9...
    if (d.length === 10 || d.length === 11) d = "55" + d;                             // DDD + número
    if (!d.startsWith("55") || (d.length !== 12 && d.length !== 13)) return { tel: null, motivo: "invalido" };
    const local = d.slice(4);                                                         // sem 55 + DDD
    if (local.length === 8 && /^[2-5]/.test(local)) return { tel: null, motivo: "fixo" };  // telefone fixo: sem WhatsApp
    return { tel: d };
  }
  function formatarTel(d) {
    if (/^55\d{10,11}$/.test(d)) {
      const ddd = d.slice(2, 4), n = d.slice(4);
      return `+55 ${ddd} ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
    }
    return "+" + d;
  }

  // ---------- vCard ----------
  function qpDecode(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(s.charCodeAt(i) & 255);
    }
    try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); } catch (_) { return s; }
  }
  const unesc = (s) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

  function lerVcf(texto) {
    // junta linhas dobradas (começam com espaço/tab) e quebras "suaves" do quoted-printable
    const brutas = texto.replace(/\r\n?/g, "\n").split("\n"), linhas = [];
    for (const l of brutas) {
      const ant = linhas[linhas.length - 1];
      if (ant !== undefined && /ENCODING=QUOTED-PRINTABLE/i.test(ant) && /=$/.test(ant)) linhas[linhas.length - 1] = ant.slice(0, -1) + l;
      else if (/^[ \t]/.test(l) && ant !== undefined) linhas[linhas.length - 1] = ant + l.slice(1);
      else linhas.push(l);
    }
    const cards = []; let cur = null;
    for (const l of linhas) {
      if (/^BEGIN:VCARD/i.test(l)) cur = { fn: "", n: "", tels: [] };
      else if (/^END:VCARD/i.test(l)) { if (cur) cards.push(cur); cur = null; }
      else if (cur) {
        const m = l.match(/^((?:item\d+\.)?([A-Za-z]+))((?:;[^:]*)?):(.*)$/);
        if (!m) continue;
        const campo = m[2].toUpperCase(), params = m[3] || "";
        let v = m[4];
        if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) v = qpDecode(v);
        if (campo === "FN") cur.fn = unesc(v);
        else if (campo === "N") { const [fam = "", giv = ""] = v.split(";"); cur.n = unesc((giv + " " + fam).trim()); }
        else if (campo === "TEL") cur.tels.push(v.trim());
      }
    }
    return cards.map((c) => ({ nome: c.fn || c.n, tels: c.tels }));
  }

  // ---------- CSV ----------
  function lerCsvLinhas(texto) {
    const t = texto.replace(/^﻿/, "");
    const primeira = (t.split(/\r?\n/)[0] || "");
    const cont = (c) => primeira.split(c).length - 1;
    const delim = [[";", cont(";")], ["\t", cont("\t")], [",", cont(",")]].sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cel = "", asp = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (asp) {
        if (c === '"') { if (t[i + 1] === '"') { cel += '"'; i++; } else asp = false; } else cel += c;
      } else if (c === '"') asp = true;
      else if (c === delim) { row.push(cel); cel = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cel); cel = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
      else cel += c;
    }
    row.push(cel); if (row.some((x) => x.trim())) rows.push(row);
    return rows;
  }
  const semAcento = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

  function lerCsv(texto) {
    const rows = lerCsvLinhas(texto);
    if (!rows.length) return [];
    const cab = rows[0].map(semAcento);
    const idx = (re, excl) => cab.map((h, i) => (re.test(h) && !(excl && excl.test(h)) ? i : -1)).filter((i) => i >= 0);
    const EXCL_LABEL = /(label|type|tipo)/;
    let nomeCols = idx(/^(name|nome|full name|nome completo|display name|nome do contato|paciente)$/);
    const partes = idx(/^(first name|given name|primeiro nome|middle name|last name|family name|sobrenome)$/);
    const telCols = idx(/(phone|tel|telefone|celular|whatsapp|mobile|fone|contato)/, EXCL_LABEL)
      .filter((i) => !nomeCols.includes(i) && !/(name|nome)/.test(cab[i]));
    // sem cabeçalho reconhecível: planilha simples "nome, telefone"
    let ini = 1;
    if (!nomeCols.length && !partes.length && !telCols.length) {
      ini = 0; nomeCols = [0]; telCols.push(1);
    }
    const out = [];
    for (let r = ini; r < rows.length; r++) {
      const L = rows[r];
      const nome = (nomeCols.length ? nomeCols.map((i) => L[i] || "").join(" ") : partes.map((i) => L[i] || "").join(" ")).replace(/\s+/g, " ").trim()
        || partes.map((i) => L[i] || "").join(" ").replace(/\s+/g, " ").trim();
      const tels = [];
      for (const i of telCols) for (const p of String(L[i] || "").split(/\s*:::\s*|\s*\|\s*|\n/)) if (p.trim()) tels.push(p.trim());
      out.push({ nome, tels });
    }
    return out;
  }

  // ---------- importação ----------
  // Consolida "contatos brutos" {nome, tels[]} em contatos usáveis.
  // Devolve { contatos:[{nome,tel}], lidos, semTelefone, fixos, invalidos, semNome, repetidosNoArquivo }
  function consolidar(brutos) {
    const r = { contatos: [], lidos: brutos.length, semTelefone: 0, fixos: 0, invalidos: 0, semNome: 0, repetidosNoArquivo: 0 };
    const vistos = new Set();
    for (const b of brutos) {
      if (!b.tels || !b.tels.length) { r.semTelefone++; continue; }
      let achado = null, fixo = false;
      for (const raw of b.tels) {
        const n = normalizarTel(raw);
        if (n.tel) { achado = n.tel; break; }
        if (n.motivo === "fixo") fixo = true;
      }
      if (!achado) { if (fixo) r.fixos++; else r.invalidos++; continue; }
      if (vistos.has(achado)) { r.repetidosNoArquivo++; continue; }
      vistos.add(achado);
      let nome = (b.nome || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!nome) { nome = formatarTel(achado); r.semNome++; }
      r.contatos.push({ nome, tel: formatarTel(achado) });
    }
    return r;
  }
  function importar(texto, nomeArquivo) {
    const ehVcf = /\.vcf$/i.test(nomeArquivo || "") || /^\s*BEGIN:VCARD/i.test(texto);
    return consolidar(ehVcf ? lerVcf(texto) : lerCsv(texto));
  }

  // Junta os novos aos existentes sem duplicar telefone. O que já existe vence.
  function mesclar(existentes, novos) {
    const chave = (c) => (normalizarTel(c.tel).tel || String(c.tel).replace(/\D/g, ""));
    const set = new Set(existentes.map(chave));
    const lista = existentes.slice(); let adicionados = 0, repetidos = 0;
    for (const c of novos) {
      const k = chave(c);
      if (set.has(k)) { repetidos++; continue; }
      set.add(k); lista.push(c); adicionados++;
    }
    return { lista, adicionados, repetidos };
  }

  window.JarvisContatos = { normalizarTel, formatarTel, importar, consolidar, mesclar, _lerVcf: lerVcf, _lerCsv: lerCsv };
})();
