// Chamada semanalmente (pelo agendador em supabase/cron-setup.sql — mesmo
// esquema já usado pra whatsapp-process-inbox) — nunca diretamente pelo
// painel. Exporta as tabelas mais sensíveis (conversas, leads, CRM) como
// JSON pro bucket privado "backups" no Storage, como uma rede de segurança
// gratuita enquanto o projeto está no plano Free do Supabase (que não tem
// backup automático). Mantém só as últimas ~8 execuções, pra não crescer
// sem limite.
//
// Segredos necessários (Project Settings → Edge Functions → Secrets):
//   CRON_SECRET                mesma senha já usada na whatsapp-process-inbox
//   SUPABASE_URL               já vem configurado automaticamente
//   SUPABASE_SERVICE_ROLE_KEY  já vem configurado automaticamente
//
// Em Settings desta function, desligue "Enforce JWT Verification" — quem
// chama aqui é o agendador (pg_cron), não um usuário logado.

import { createClient } from "npm:@supabase/supabase-js@2";

const TABELAS = ["wa_messages", "wa_inbox", "leads", "crm_segmentados"] as const;
const MANTER_EXECUCOES = 8;

Deno.serve(async (req) => {
  try {
    const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
    if (CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
      return new Response(JSON.stringify({ error: "Não autorizado." }), { status: 401 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const resultados: Record<string, unknown>[] = [];

    for (const tabela of TABELAS) {
      const { data, error } = await supabase.from(tabela).select("*");
      if (error) {
        resultados.push({ tabela, erro: error.message });
        continue;
      }
      const bytes = new TextEncoder().encode(JSON.stringify(data ?? []));
      const { error: uploadError } = await supabase.storage
        .from("backups")
        .upload(`${runId}/${tabela}.json`, bytes, { contentType: "application/json", upsert: true });
      resultados.push({ tabela, linhas: data?.length ?? 0, ok: !uploadError, erro: uploadError?.message });
    }

    // Poda: mantém só as últimas MANTER_EXECUCOES pastas (uma por execução),
    // apagando as mais antigas pra não crescer sem limite.
    const { data: pastas } = await supabase.storage.from("backups").list("", {
      limit: 1000,
      sortBy: { column: "name", order: "asc" },
    });
    const nomesPastas = (pastas ?? []).map((p) => p.name).filter((n) => n && n !== runId).sort();
    const excedentes = nomesPastas.slice(0, Math.max(0, nomesPastas.length + 1 - MANTER_EXECUCOES));
    for (const pasta of excedentes) {
      const { data: arquivos } = await supabase.storage.from("backups").list(pasta);
      const caminhos = (arquivos ?? []).map((a) => `${pasta}/${a.name}`);
      if (caminhos.length) await supabase.storage.from("backups").remove(caminhos);
    }

    return new Response(JSON.stringify({ ok: true, runId, resultados, execucoesApagadas: excedentes }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
