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
//      EVOLUTION_API_URL         mesma da whatsapp-proxy (ex.: https://sua-evolution.up.railway.app)
//      EVOLUTION_API_KEY         mesma da whatsapp-proxy
//      EVOLUTION_INSTANCE        mesma da whatsapp-proxy
//    (as 3 últimas são pra baixar o conteúdo de foto/vídeo/áudio/figurinha
//    recebido — sem elas a mensagem ainda é salva, só sem o arquivo.)
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
    message.text || // formato usado por /chat/findMessages nesta instância (confirmado com dado real)
    ""
  );
}

// Identifica o tipo da mensagem, pra já ficar salvo mesmo sem exibir ainda
// nada além de texto na tela (anexos ficam pra uma etapa futura).
function extractTipo(message: any): string {
  if (!message) return "outro";
  if (message.conversation || message.extendedTextMessage || message.text) return "texto";
  if (message.imageMessage) return "imagem";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.stickerMessage) return "figurinha";
  if (message.documentMessage || message.documentWithCaptionMessage) return "documento";
  return "outro";
}

// Pega o "nó" de mídia certo dentro de message, conforme o tipo — cada um
// tem mimetype no mesmo formato (campo "mimetype" do proto do WhatsApp).
function extractMediaNode(message: any, tipo: string): any {
  if (!message) return null;
  if (tipo === "imagem") return message.imageMessage;
  if (tipo === "video") return message.videoMessage;
  if (tipo === "audio") return message.audioMessage;
  if (tipo === "figurinha") return message.stickerMessage;
  if (tipo === "documento") return message.documentMessage || message.documentWithCaptionMessage?.message?.documentMessage;
  return null;
}

function extensaoPorMime(mimetype: string | undefined, fallback: string): string {
  if (!mimetype) return fallback;
  const sub = mimetype.split(";")[0].split("/")[1];
  return sub ? sub.replace(/[^a-z0-9]/gi, "").toLowerCase() || fallback : fallback;
}

// Baixa o conteúdo binário de uma mensagem de mídia já recebida e sobe pro
// bucket privado "wa-media". A Evolution API v2.x documenta o endpoint
// /chat/getBase64FromMediaMessage/{instance} pra isso — como este ambiente
// não tem acesso à instância real pra confirmar o formato exato da
// resposta, a leitura abaixo tenta os nomes de campo mais prováveis
// (base64/mimetype nas raiz e dentro de "media") e, se nenhum bater, loga
// a resposta bruta (aba Logs da function) em vez de falhar calado — mesmo
// padrão já usado na ação "sync-messages" da whatsapp-proxy.
async function baixarEGuardarMidia(
  supabase: any,
  evolutionUrl: string,
  evolutionKey: string,
  instance: string,
  waMessageId: string,
  telefone: string,
  mediaNode: any,
  tipo: string,
): Promise<{ path: string; mime: string } | null> {
  try {
    const r = await fetch(`${evolutionUrl}/chat/getBase64FromMediaMessage/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: evolutionKey },
      body: JSON.stringify({ message: { key: { id: waMessageId } }, convertToMp4: false }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      console.log(JSON.stringify({ event: "whatsapp_media_download_erro_http", waMessageId, status: r.status, detalhe: data }));
      return null;
    }
    const base64: string | undefined = data?.base64 || data?.media?.base64 || (typeof data === "string" ? data : undefined);
    const mimetype: string = data?.mimetype || data?.media?.mimetype || mediaNode?.mimetype || "application/octet-stream";
    if (!base64) {
      console.log(JSON.stringify({ event: "whatsapp_media_download_formato_desconhecido", waMessageId, detalhe: data }));
      return null;
    }
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const ext = extensaoPorMime(mimetype, tipo === "figurinha" ? "webp" : "bin");
    const path = `${telefone}/${waMessageId}.${ext}`;
    const { error } = await supabase.storage.from("wa-media").upload(path, bytes, { contentType: mimetype, upsert: true });
    if (error) {
      console.log(JSON.stringify({ event: "whatsapp_media_upload_erro", waMessageId, erro: error.message }));
      return null;
    }
    return { path, mime: mimetype };
  } catch (e) {
    console.log(JSON.stringify({ event: "whatsapp_media_download_excecao", waMessageId, erro: String(e) }));
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
  const url = new URL(req.url);
  if (WEBHOOK_SECRET && url.searchParams.get("secret") !== WEBHOOK_SECRET) {
    return json({ error: "Não autorizado." }, 401);
  }
  const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").trim().replace(/\/+$/, "");
  const EVOLUTION_API_KEY = (Deno.env.get("EVOLUTION_API_KEY") ?? "").trim();
  const EVOLUTION_INSTANCE = (Deno.env.get("EVOLUTION_INSTANCE") ?? "consultorio").trim();

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
      if (remoteJid.endsWith("@g.us")) continue; // grupo do WhatsApp, não conversa de paciente
      const telefone = remoteJid.split("@")[0];
      if (!telefone) continue;

      const tipo = extractTipo(item.message);
      const texto = extractText(item.message);
      const isMidia = tipo === "imagem" || tipo === "video" || tipo === "audio" || tipo === "figurinha" || tipo === "documento";
      if (!texto && !isMidia) continue; // nada de útil pra guardar (ex.: reação, mensagem de sistema)

      const nomeContato = item.pushName || null;
      const timestamp = item.messageTimestamp
        ? new Date(Number(item.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString();

      // A fila de rascunho de resposta da IA (wa_inbox) só faz sentido com
      // texto de verdade pra ler — uma foto sem legenda ainda cai no
      // histórico (wa_messages) pra aparecer na Central, mas não vira
      // "aguardando" resposta automática.
      if (texto) {
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

      // histórico completo da conversa, pra central de conversas do painel.
      // Usa upsert por wa_message_id pra nunca duplicar se a Evolution API
      // reenviar o mesmo evento de webhook (acontece na prática).
      const waMessageId: string | null = item.key?.id || null;
      let media: { path: string; mime: string } | null = null;
      if (isMidia && waMessageId && EVOLUTION_API_URL && EVOLUTION_API_KEY) {
        const mediaNode = extractMediaNode(item.message, tipo);
        media = await baixarEGuardarMidia(
          supabase, EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE,
          waMessageId, telefone, mediaNode, tipo,
        );
      }
      const mediaCols = { media_path: media?.path ?? null, media_mime: media?.mime ?? null };
      if (waMessageId) {
        await supabase.from("wa_messages").upsert({
          telefone, nome_contato: nomeContato, direcao: "recebida", texto, tipo, ...mediaCols,
          created_at: timestamp, wa_message_id: waMessageId,
        }, { onConflict: "wa_message_id" });
      } else {
        await supabase.from("wa_messages").insert({
          telefone, nome_contato: nomeContato, direcao: "recebida", texto, tipo, ...mediaCols, created_at: timestamp,
        });
      }
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
