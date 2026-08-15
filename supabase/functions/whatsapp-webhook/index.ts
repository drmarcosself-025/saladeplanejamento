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

// Alguns tipos de mensagem do WhatsApp vêm "embrulhados" — a mensagem de
// verdade fica um nível (ou mais) abaixo (mensagem temporária, "ver uma
// vez", documento com legenda). Sem desembrulhar, extractText/extractTipo
// não reconheciam nada dentro desses e a mensagem virava "outro" sem texto
// — descartada silenciosamente no sync-messages, classificada errado no
// webhook.
function desembrulhar(message: any, profundidade = 0): any {
  if (!message || profundidade > 5) return message;
  const interno =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.viewOnceMessageV2Extension?.message ||
    message.documentWithCaptionMessage?.message;
  return interno ? desembrulhar(interno, profundidade + 1) : message;
}

// Extrai o texto de diferentes formatos de mensagem que a Evolution API
// pode mandar (texto simples, resposta a mensagem citada, legenda de
// foto/vídeo/documento, etc.)
function extractText(message: any): string {
  const m = desembrulhar(message);
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.text || // formato usado por /chat/findMessages nesta instância (confirmado com dado real)
    ""
  );
}

// Identifica o tipo da mensagem. "reacao" e "sistema" nunca são conteúdo de
// paciente (reação de emoji, mensagem de protocolo/criptografia) — são
// descartadas de propósito, não por engano. Áudio, figurinha e documento
// raramente têm texto/legenda — são válidos mesmo com texto vazio (ver
// isMidia() abaixo).
function extractTipo(message: any): string {
  const m = desembrulhar(message);
  if (!m) return "outro";
  if (m.conversation || m.extendedTextMessage || m.text) return "texto";
  if (m.imageMessage) return "imagem";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.stickerMessage) return "figurinha";
  if (m.documentMessage) return "documento";
  if (m.reactionMessage) return "reacao";
  if (m.protocolMessage || m.senderKeyDistributionMessage) return "sistema";
  return "outro";
}

function isMidia(tipo: string): boolean {
  return tipo === "imagem" || tipo === "video" || tipo === "audio" || tipo === "figurinha" || tipo === "documento";
}

// Pega o "nó" de mídia certo dentro de message, conforme o tipo — cada um
// tem mimetype no mesmo formato (campo "mimetype" do proto do WhatsApp).
function extractMediaNode(message: any, tipo: string): any {
  const m = desembrulhar(message);
  if (!m) return null;
  if (tipo === "imagem") return m.imageMessage;
  if (tipo === "video") return m.videoMessage;
  if (tipo === "audio") return m.audioMessage;
  if (tipo === "figurinha") return m.stickerMessage;
  if (tipo === "documento") return m.documentMessage;
  return null;
}

function extensaoPorMime(mimetype: string | undefined, fallback: string): string {
  if (!mimetype) return fallback;
  const sub = mimetype.split(";")[0].split("/")[1];
  return sub ? sub.replace(/[^a-z0-9]/gi, "").toLowerCase() || fallback : fallback;
}

// A Evolution API já tenta resolver o telefone de verdade por trás de um
// JID oculto (@lid) quando o WhatsApp fornece essa informação (campo
// remoteJidAlt) — nesse caso o remoteJid que chega aqui já vem corrigido.
// Quando o WhatsApp NÃO fornece (contato protegido por privacidade de
// verdade), o remoteJid continua terminando em @lid — sem essa checagem,
// esse identificador opaco era salvo como se fosse um telefone real,
// contaminando o histórico, o lead e a segmentação do CRM.
function extrairTelefoneInfo(key: any): { telefone: string; ehLid: boolean } {
  const remoteJid: string = key?.remoteJid || "";
  const remoteJidAlt: string = key?.remoteJidAlt || "";
  if (remoteJid.endsWith("@lid")) {
    if (remoteJidAlt) return { telefone: remoteJidAlt.split("@")[0], ehLid: false };
    return { telefone: remoteJid.split("@")[0], ehLid: true };
  }
  return { telefone: remoteJid.split("@")[0], ehLid: false };
}

// Teto de tamanho pro download de mídia recebida — sem isso, uma mensagem
// de mídia grande vinda de qualquer número de WhatsApp (nem precisa ser da
// equipe) podia estourar a memória da function. 20MB combina com o teto
// do bucket wa-media.
const MAX_MEDIA_BASE64_CHARS = 27_000_000; // ~20MB decodificado (base64 é ~1.37x maior)

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
    if (base64.length > MAX_MEDIA_BASE64_CHARS) {
      console.log(JSON.stringify({ event: "whatsapp_media_download_muito_grande", waMessageId, tamanhoBase64: base64.length }));
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

    // Nunca responder "ok" pra Evolution API se a gravação principal
    // (wa_messages) falhou — ela usa a resposta pra decidir se reenvia o
    // evento (retry automático já embutido na Evolution). Sem isso, um
    // erro de banco (RLS, coluna obrigatória, timeout) fazia a mensagem
    // sumir silenciosamente, sem log e sem chance de reenvio.
    const falhasGraves: string[] = [];

    for (const item of items) {
      if (!item) continue;
      if (item.key?.fromMe) continue; // ignora mensagens que a própria clínica mandou

      const remoteJid: string = item.key?.remoteJid || "";
      if (remoteJid.endsWith("@g.us")) continue; // grupo do WhatsApp, não conversa de paciente
      let { telefone, ehLid } = extrairTelefoneInfo(item.key);
      if (!telefone) continue;

      // Proteção contra regressão: se essa mesma mensagem (mesmo
      // wa_message_id) já estava salva com um telefone de verdade
      // (telefone_e_lid=false), nunca deixa um reprocessamento com LID
      // não resolvido piorar esse dado — mantém o que já era melhor.
      const waMessageId: string | null = item.key?.id || null;
      if (ehLid && waMessageId) {
        const { data: existenteMsg } = await supabase
          .from("wa_messages")
          .select("telefone, telefone_e_lid")
          .eq("wa_message_id", waMessageId)
          .maybeSingle();
        if (existenteMsg && existenteMsg.telefone_e_lid === false) {
          telefone = existenteMsg.telefone;
          ehLid = false;
        }
      }

      const tipo = extractTipo(item.message);
      if (tipo === "reacao" || tipo === "sistema") continue; // nunca é conteúdo de paciente
      const texto = extractText(item.message);
      const midia = isMidia(tipo);
      if (!texto && !midia) continue; // formato não reconhecido, sem nada útil pra guardar

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

        // wa_inbox é secundária (só alimenta o rascunho automático da IA)
        // — um erro aqui não deve impedir o histórico principal de ser
        // salvo, mas precisa ficar registrado, não desaparecer calado.
        const resultadoInbox = existente
          ? await supabase
              .from("wa_inbox")
              .update({
                mensagens: [...(existente.mensagens || []), { texto, timestamp }],
                ultima_mensagem_em: timestamp, nome_contato: nomeContato, telefone_e_lid: ehLid,
              })
              .eq("id", existente.id)
          : await supabase.from("wa_inbox").insert({
              telefone, nome_contato: nomeContato, mensagens: [{ texto, timestamp }],
              ultima_mensagem_em: timestamp, status: "aguardando", telefone_e_lid: ehLid,
            });
        if (resultadoInbox.error) {
          console.log(JSON.stringify({ event: "whatsapp_wa_inbox_erro", waMessageId, erro: resultadoInbox.error.message }));
        }
      }

      // histórico completo da conversa, pra central de conversas do painel.
      // Usa upsert por wa_message_id pra nunca duplicar se a Evolution API
      // reenviar o mesmo evento de webhook (acontece na prática).
      let media: { path: string; mime: string } | null = null;
      if (midia && waMessageId && EVOLUTION_API_URL && EVOLUTION_API_KEY) {
        const mediaNode = extractMediaNode(item.message, tipo);
        media = await baixarEGuardarMidia(
          supabase, EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE,
          waMessageId, telefone, mediaNode, tipo,
        );
      }
      const mediaCols = { media_path: media?.path ?? null, media_mime: media?.mime ?? null };
      const { error: erroMensagem } = waMessageId
        ? await supabase.from("wa_messages").upsert({
            telefone, nome_contato: nomeContato, direcao: "recebida", texto, tipo, ...mediaCols,
            created_at: timestamp, wa_message_id: waMessageId, telefone_e_lid: ehLid,
          }, { onConflict: "wa_message_id" })
        : await supabase.from("wa_messages").insert({
            telefone, nome_contato: nomeContato, direcao: "recebida", texto, tipo, ...mediaCols,
            created_at: timestamp, telefone_e_lid: ehLid,
          });
      if (erroMensagem) {
        console.log(JSON.stringify({ event: "whatsapp_wa_messages_erro", waMessageId, erro: erroMensagem.message }));
        falhasGraves.push(erroMensagem.message);
      }
    }

    // Se alguma mensagem não foi salva de verdade, avisa a Evolution API
    // com erro (em vez de "ok:true") — ela já tem retry automático com
    // backoff, então isso dá uma segunda chance sem precisar de nada
    // construído por nós. "Sucesso" só quando realmente gravou tudo.
    if (falhasGraves.length > 0) {
      return json({ error: "Falha ao gravar uma ou mais mensagens.", detalhes: falhasGraves }, 500);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
