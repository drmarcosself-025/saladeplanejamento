(function () {
  const $ = (id) => document.getElementById(id), B = JarvisBackup;
  let arquivo = null;
  const status = (s) => { $("backupStatus").textContent = s; };
  $("backupBaixar").addEventListener("click", async () => {
    let json;
    try { json = JSON.stringify(B.gerar(), null, 2); } catch (e) { status(e.message); return; }
    const nome = `jarvis-backup-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const dl = window.claude && window.claude.use && await window.claude.use("downloads");
      if (dl) { await dl.save({ filename: nome, data: json }); status("Backup salvo. Guarde o arquivo em local privado."); return; }
    } catch (e) { if (e && e.code === "declined") { status("O download foi cancelado."); return; } }
    try {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = nome; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status("Download solicitado ao navegador. Confira se o arquivo foi salvo.");
    } catch (_) { status("Não consegui iniciar o download neste aparelho."); }
  });
  $("backupArquivo").addEventListener("change", async (e) => {
    arquivo = null; $("backupRestaurar").hidden = true; $("backupPrevia").textContent = "";
    const file = e.target.files && e.target.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { status("Arquivo grande demais (limite: 5 MB)."); return; }
    try {
      const raw = JSON.parse(await file.text()), v = B.validar(raw);
      arquivo = raw;
      $("backupPrevia").textContent = `${v.leads.length} leads · ${v.financeiro.length} registros financeiros · ${v.contatos.length} contatos · ${v.pessoal.tarefas.length} tarefas. Seu perfil do arquivo substituirá o atual; a opção de enviar contexto ao Claude ficará desligada.`;
      $("backupRestaurar").hidden = false;
      status("Confira os números acima antes de restaurar.");
    } catch (err) { status(err.message || "Não consegui ler este arquivo JSON."); }
  });
  $("backupRestaurar").addEventListener("click", async (e) => {
    if (!arquivo) return;
    const b = e.currentTarget; b.disabled = true; status("Restaurando dados…");
    try {
      const r = await B.restaurar(arquivo);
      status(`Restaurado: ${r.leads} leads, ${r.financeiro} registros financeiros, ${r.contatos} contatos e ${r.tarefas} tarefas. Perfil: ${r.pessoal ? "salvo" : "não salvo"}.${r.ignoradas ? ` ${r.ignoradas} tarefas não couberam no limite de 100.` : ""}${r.falhas ? ` ${r.falhas} item(ns) falharam; confira antes de apagar o arquivo.` : " Itens já presentes foram mantidos."}`);
      window.dispatchEvent(new Event("jarvis:restaurado")); JarvisUI.navegar("pessoal"); JarvisUI.render();
      arquivo = null; b.hidden = true; $("backupArquivo").value = "";
    } catch (err) { status(err.message || "Não consegui restaurar. Seus dados atuais foram mantidos."); }
    finally { b.disabled = false; }
  });
})();
