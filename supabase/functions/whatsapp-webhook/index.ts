// Recebe os eventos de mensagem da Evolution API (webhook) e guarda as
// mensagens do paciente numa "caixa de entrada" (wa_inbox), aguardando
// o processamento periódico que gera o rascunho de resposta da IA
// (feito pela function whatsapp-process-inbox, chamada pelo agendador
// em supabase/cron-setup.sql).
//
// Configuração necessária:
// 1. No painel da Evolution API (ou nas variáveis do serviço no
//    Railway), aponte o webhook pra:
//      https://<seu-projeto>.supabase.co/functions/v1/whatsapp-webhook?secret=SEU_WEBHOOK_SECRET
//    habilitando pelo menos o evento "MESSAGES_UPSERT".
// 2. Nesta function, em Project Settings → Edge Functions → Secrets,
//    configure:
//      WEBHOOK_SECRET            a mesma senha usada no passo 1
//      SUPABASE_URL              já vem automaticamente
//      SUPABASE_SERVICE_ROLE_KEY já vem automaticamente
// 3. Em Settings desta function, desligue "Enforce JWT Verification"
//    (quem chama aqui é a Evolution API, não um usuário logado — a
//    proteção é o "secret" da URL, não o JWT do Supabase).

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Extrai o texto de diferentes formatos de mensagem que a Evolution API
// pode mandar (texto simples, resposta a mensagem citada, legenda de
// foto/vídeo, etc.)
function extractText(message: any): string {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
  const url = new URL(req.url);
  if (WEBHOOK_SECRET && url.searchParams.get("secret") !== WEBHOOK_SECRET) {
    return json({ error: "Não autorizado." }, 401);
  }

  try {
    const body = await req.json();
    const event = (body.event || body.Event || "").toString().toLowerCase();
    if (event !== "messages.upsert") {
      return json({ ok: true, ignored: true });
    }

    const items = Array.isArray(body.data) ? body.data : [body.data];
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    for (const item of items) {
      if (!item) continue;
      if (item.key?.fromMe) continue; // ignora mensagens que a própria clínica mandou

      const remoteJid: string = item.key?.remoteJid || "";
      const telefone = remoteJid.split("@")[0];
      if (!telefone) continue;

      const texto = extractText(item.message);
      if (!texto) continue; // ignora áudio, figurinha, etc. por enquanto

      const nomeContato = item.pushName || null;
      const timestamp = item.messageTimestamp
        ? new Date(Number(item.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString();

      const { data: existente } = await supabase
        .from("wa_inbox")
        .select("id, mensagens")
        .eq("telefone", telefone)
        .eq("status", "aguardando")
        .maybeSingle();

      if (existente) {
        const mensagens = [...(existente.mensagens || []), { texto, timestamp }];
        await supabase
          .from("wa_inbox")
          .update({ mensagens, ultima_mensagem_em: timestamp, nome_contato: nomeContato })
          .eq("id", existente.id);
      } else {
        await supabase.from("wa_inbox").insert({
          telefone,
          nome_contato: nomeContato,
          mensagens: [{ texto, timestamp }],
          ultima_mensagem_em: timestamp,
          status: "aguardando",
        });
      }
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
