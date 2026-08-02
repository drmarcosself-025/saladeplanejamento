// Chamada periodicamente (a cada minuto, pelo agendador configurado em
// supabase/cron-setup.sql) — nunca diretamente pelo painel. Processa as
// conversas de WhatsApp que ficaram paradas por alguns segundos (ou
// seja, o paciente parou de mandar mensagem), e:
//   1. Gera um rascunho de resposta com a IA (usando o texto salvo em
//      IA & Prompt), juntando todas as mensagens em sequência numa
//      resposta só — pra um humano revisar e aprovar antes de enviar.
//   2. Procura palavras-chave de interesse nas mensagens do paciente
//      e, se achar, já cria o lead automaticamente na aba Leads
//      (ou vincula a um lead existente com o mesmo telefone).
//
// Segredos necessários (Project Settings → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY          sua chave da Anthropic (Claude)
//   ANTHROPIC_MODEL            opcional — padrão: claude-sonnet-4-5-20250929
//   SUPABASE_URL               já vem configurado automaticamente
//   SUPABASE_SERVICE_ROLE_KEY  já vem configurado automaticamente
//
// Em Settings desta function, desligue "Enforce JWT Verification" —
// quem chama aqui é o agendador (pg_cron), não um usuário logado.

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (_req) => {
  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5-20250929";
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada nos segredos da function." }), { status: 500 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: configRow } = await supabase.from("config").select("wa_silencio_seg, wa_keywords").eq("id", 1).single();
    const silencioSeg = configRow?.wa_silencio_seg ?? 12;
    const keywords: string[] = (configRow?.wa_keywords ?? "")
      .split(",")
      .map((k: string) => k.trim().toLowerCase())
      .filter(Boolean);

    const { data: iaPromptRow } = await supabase.from("ia_prompt").select("texto").eq("id", 1).single();
    const iaPrompt = iaPromptRow?.texto ||
      "Você é o assistente virtual de um consultório odontológico. Responda de forma breve, profissional e acolhedora, sem diagnosticar nem prometer resultados.";

    const cutoff = new Date(Date.now() - silencioSeg * 1000).toISOString();
    const { data: pendentes, error: pendErr } = await supabase
      .from("wa_inbox")
      .select("*")
      .eq("status", "aguardando")
      .lte("ultima_mensagem_em", cutoff)
      .limit(20);

    if (pendErr) return new Response(JSON.stringify({ error: pendErr.message }), { status: 500 });

    const resultados = [];
    for (const conversa of pendentes || []) {
      const mensagensTexto = (conversa.mensagens || []).map((m: any) => m.texto).join("\n");

      let draft = "";
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 500,
            system: iaPrompt,
            messages: [{
              role: "user",
              content: `O paciente enviou estas mensagens em sequência. Responda a todas juntas, de forma natural, como se fosse uma única mensagem:\n\n${mensagensTexto}`,
            }],
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error?.message || "Falha ao gerar resposta com a IA.");
        draft = (data.content || []).map((c: any) => c.text || "").join("\n").trim();
      } catch (e) {
        resultados.push({ id: conversa.id, erro: String(e) });
        continue; // deixa como "aguardando" pra tentar de novo na próxima rodada
      }

      const textoBusca = mensagensTexto.toLowerCase();
      const encontradas = keywords.filter((k) => k && textoBusca.includes(k));

      let leadId: string | null = null;
      const leadSugerido = encontradas.length > 0;
      if (leadSugerido) {
        const { data: leadExistente } = await supabase
          .from("leads")
          .select("id")
          .eq("telefone", conversa.telefone)
          .is("deleted_at", null)
          .maybeSingle();

        if (leadExistente) {
          leadId = leadExistente.id;
        } else {
          const { data: novoLead } = await supabase.from("leads").insert({
            nome: conversa.nome_contato || conversa.telefone,
            telefone: conversa.telefone,
            origem: "Lead próprio",
            status: "Novo",
            responsavel: "IA (automático)",
            obs: `Criado automaticamente pela IA a partir de uma conversa de WhatsApp. Palavra(s)-chave detectada(s): ${encontradas.join(", ")}.`,
            atividades: [{
              data: new Date().toISOString().slice(0, 10),
              tipo: "Criação",
              texto: "Lead criado automaticamente via WhatsApp (IA)",
              por: "IA (automático)",
            }],
            created_by: "IA (automático)",
          }).select("id").single();
          leadId = novoLead?.id || null;
        }
      }

      await supabase.from("wa_inbox").update({
        status: "rascunho_pronto",
        rascunho_resposta: draft,
        palavras_chave_detectadas: encontradas,
        lead_sugerido: leadSugerido,
        lead_id: leadId,
        processado_em: new Date().toISOString(),
      }).eq("id", conversa.id);

      resultados.push({ id: conversa.id, ok: true });
    }

    return new Response(JSON.stringify({ processadas: resultados.length, resultados }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
