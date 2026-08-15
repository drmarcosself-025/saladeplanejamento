// Proxy seguro entre o painel e a Evolution API (WhatsApp via Baileys).
//
// A apikey da Evolution API dá controle total da conexão de WhatsApp e por
// isso NUNCA deve aparecer no código do site (index.html). Esta function
// guarda a chave como segredo no servidor e só repassa a chamada pra
// Evolution API depois de confirmar que quem pediu está logado no painel
// (e, para ações administrativas, que é o proprietário).
//
// Configuração necessária (Project Settings → Edge Functions → Secrets):
//   EVOLUTION_API_URL      ex.: https://sua-evolution.up.railway.app
//   EVOLUTION_API_KEY      a "Global API Key" da sua Evolution API
//   EVOLUTION_INSTANCE     nome da instância, ex.: consultorio-marcos-paulo
//   SUPABASE_URL           já vem configurado automaticamente
//   SUPABASE_ANON_KEY      já vem configurado automaticamente

import { createClient } from "npm:@supabase/supabase-js@2";

// Mesma lógica de extração usada no whatsapp-webhook (duplicada aqui de
// propósito: cada Edge Function do Supabase é colada/publicada de forma
// independente, sem importar arquivo de outra function). Se mudar aqui,
// mudar lá também — as duas precisam classificar mensagem exatamente igual.
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

// Mesma regra do waLink() no index.html: número sem código de país (55) é
// inválido pro WhatsApp verificar ("exists: false"), mesmo sendo um número
// de verdade — confirmado com o teste real do usuário.
function toWhatsappDigits(number: string): string {
  const digits = String(number || "").replace(/\D/g, "");
  return digits.startsWith("55") ? digits : "55" + digits;
}

// Mesma lógica de detecção de LID usada no whatsapp-webhook (duplicada de
// propósito — cada Edge Function é publicada independente).
function extrairTelefoneInfo(key: any): { telefone: string; ehLid: boolean } {
  const remoteJid: string = key?.remoteJid || "";
  const remoteJidAlt: string = key?.remoteJidAlt || "";
  if (remoteJid.endsWith("@lid")) {
    if (remoteJidAlt) return { telefone: remoteJidAlt.split("@")[0], ehLid: false };
    return { telefone: remoteJid.split("@")[0], ehLid: true };
  }
  return { telefone: remoteJid.split("@")[0], ehLid: false };
}

const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // combina com o file_size_limit do bucket wa-media

// "status" fica de fora: qualquer pessoa da equipe precisa poder ver se o
// WhatsApp está conectado na tela de Atendimento. Só quem realmente
// gerencia a conexão (gerar QR, desconectar) é owner-only.
const ADMIN_ACTIONS = ["create-instance", "get-qr", "logout"];

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

// Protege qualquer envio (texto ou mídia) contra bloqueio do WhatsApp por
// volume/ritmo suspeito. Reforçada aqui no servidor porque qualquer sessão
// válida poderia chamar a ação direto, sem passar pela checagem que também
// existe no navegador.
//
// A checagem E a reserva (insert em wa_send_log) acontecem dentro da mesma
// função de banco (public.wa_throttle_claim, em schema.sql), protegida por
// um advisory lock — assim duas chamadas simultâneas não conseguem mais
// ler o mesmo estado "livre" e passar juntas (o que antes era possível,
// já que a checagem e o registro eram dois passos separados).
async function reservarEnvio(
  supabase: any,
  telefone: string,
  nome: string | null | undefined,
  createdBy: string | null | undefined,
): Promise<{ ok: true; logId: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("wa_throttle_claim", {
    p_telefone: telefone,
    p_nome: nome ?? null,
    p_created_by: createdBy ?? null,
  });
  if (error) return { ok: false, error: error.message };
  if (!data?.ok) return { ok: false, error: data?.error ?? "Não foi possível enviar agora." };
  return { ok: true, logId: data.log_id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").trim().replace(/\/+$/, "");
  const EVOLUTION_API_KEY = (Deno.env.get("EVOLUTION_API_KEY") ?? "").trim();
  // .trim() aqui é de propósito: um espaço a mais no segredo (fácil de
  // acontecer colando no painel do Supabase) faz a URL da instância virar
  // outro nome pra Evolution API e a chamada dar 404 sem nenhuma pista clara.
  const EVOLUTION_INSTANCE = (Deno.env.get("EVOLUTION_INSTANCE") ?? "consultorio").trim();

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    return json({ error: "Evolution API ainda não configurada nos segredos da function." }, 500);
  }

  try {
    // Reaproveita a apikey que o próprio supabase-js já manda em toda
    // chamada, em vez de depender do nome antigo SUPABASE_ANON_KEY (que
    // aparece como "deprecated" em projetos que já migraram pro sistema
    // novo de chaves — publishable/secret).
    const incomingApiKey = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      incomingApiKey,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Não autenticado." }, 401);

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!profile) return json({ error: "Perfil não encontrado." }, 403);

    const { action, ...params } = await req.json();

    if (ADMIN_ACTIONS.includes(action) && profile.role !== "owner") {
      return json({ error: "Só o proprietário pode gerenciar a conexão do WhatsApp." }, 403);
    }

    const headers = { "Content-Type": "application/json", "apikey": EVOLUTION_API_KEY };

    if (action === "create-instance") {
      const r = await fetch(`${EVOLUTION_API_URL}/instance/create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ instanceName: EVOLUTION_INSTANCE, integration: "WHATSAPP-BAILEYS", qrcode: true }),
      });
      return json(await r.json(), r.status);
    }

    if (action === "get-qr") {
      const r = await fetch(`${EVOLUTION_API_URL}/instance/connect/${EVOLUTION_INSTANCE}`, { headers });
      return json(await r.json(), r.status);
    }

    if (action === "status") {
      const r = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${EVOLUTION_INSTANCE}`, { headers });
      return json(await r.json(), r.status);
    }

    if (action === "logout") {
      const r = await fetch(`${EVOLUTION_API_URL}/instance/logout/${EVOLUTION_INSTANCE}`, { method: "DELETE", headers });
      return json(await r.json(), r.status);
    }

    // Foto de perfil do contato no WhatsApp — pra mostrar no lugar do
    // círculo com iniciais. Se o contato não tiver foto pública (ou for
    // um LID não resolvido), a Evolution retorna sem profilePictureUrl e
    // o painel volta pras iniciais sozinho.
    if (action === "get-profile-pic") {
      const numero = String(params?.telefone ?? "").replace(/\D/g, "");
      if (!numero) return json({ error: "Telefone não informado." }, 400);
      const r = await fetch(`${EVOLUTION_API_URL}/chat/fetchProfilePictureUrl/${EVOLUTION_INSTANCE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ number: numero }),
      });
      if (!r.ok) return json({ url: null });
      const data = await r.json().catch(() => null);
      return json({ url: data?.profilePictureUrl ?? null });
    }

    // Nome de exibição do contato — só é chamado pelo painel quando a
    // conversa não tem nenhum nome guardado ainda (o WhatsApp nem sempre
    // manda pushName junto da mensagem, principalmente em histórico
    // antigo trazido pelo Sincronizar). /chat/whatsappNumbers é o mesmo
    // endpoint que a Evolution usa pra verificar se um número existe no
    // WhatsApp, e já devolve o nome público quando existe — mais leve do
    // que /chat/fetchProfile (que também busca foto/status/perfil comercial
    // desnecessariamente aqui).
    if (action === "get-contact-name") {
      const numero = String(params?.telefone ?? "").replace(/\D/g, "");
      if (!numero) return json({ error: "Telefone não informado." }, 400);
      const r = await fetch(`${EVOLUTION_API_URL}/chat/whatsappNumbers/${EVOLUTION_INSTANCE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ numbers: [numero] }),
      });
      if (!r.ok) return json({ name: null });
      const data = await r.json().catch(() => null);
      const info = Array.isArray(data) ? data[0] : data;
      const nomeBruto: string = info?.name || "";
      // Um nome de exibição de verdade nunca é só dígitos — se a Evolution
      // devolver isso (ex.: sem nome salvo, ela ecoa o número/JID de volta
      // em "name"), não é um nome, é ruído. Confirmado na prática: causou
      // um contato aparecer com o código LID como "nome".
      const nomeValido = nomeBruto && !/^\d+$/.test(nomeBruto.trim());
      return json({ name: nomeValido ? nomeBruto : null });
    }

    if (action === "send-text") {
      const { number, text, nome } = params as { number?: string; text?: string; nome?: string };
      if (!number || !text) return json({ error: "Faltou número ou texto." }, 400);

      // O composer do painel chama essa ação de verdade (waComposeSendBtn) —
      // mas qualquer pessoa com uma sessão válida também poderia chamá-la
      // direto, sem passar pela checagem de intervalo/limite que existe no
      // navegador. Por isso a política anti-bloqueio é reforçada aqui
      // também, no servidor, e não só no index.html.
      const digits = toWhatsappDigits(number);
      const reserva = await reservarEnvio(supabase, digits, nome, user.email);
      if (!reserva.ok) return json({ error: reserva.error }, 429);

      const startedAt = Date.now();
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ number: digits, text }),
      });
      // Defensivo: se a Evolution (ou um proxy na frente dela) responder
      // algo que não é JSON válido (erro 502 em HTML, corpo vazio), isso
      // não pode derrubar a function inteira com uma exceção sem log.
      const respBody = await r.json().catch(() => null);
      // Log estruturado (aba "Logs" da function no Supabase) — nunca o
      // número completo nem o texto da mensagem, só o suficiente pra
      // diagnosticar (status, tempo, ack/status da Evolution).
      console.log(JSON.stringify({
        event: "whatsapp_send_text",
        instance: EVOLUTION_INSTANCE,
        numero_final: digits.slice(-4),
        status_http: r.status,
        elapsed_ms: Date.now() - startedAt,
        ack_status: respBody?.status ?? respBody?.message?.[0]?.status ?? null,
        message_id: respBody?.key?.id ?? null,
        exists_check: respBody?.response?.message?.[0]?.exists ?? null,
        resposta_nao_json: respBody === null,
      }));
      if (r.ok && respBody) {
        // Grava aqui (no servidor), não no navegador — assim o histórico
        // fica correto mesmo se o navegador do atendente fechar ou cair
        // logo depois do envio já ter sido confirmado pela Evolution API.
        const waMessageId: string | null = respBody?.key?.id ?? null;
        const { error: erroGravar } = await supabase.from("wa_messages").insert({
          telefone: digits, nome_contato: nome ?? null, direcao: "enviada", texto: text,
          wa_message_id: waMessageId, created_by: user.email ?? null,
        });
        // A mensagem FOI enviada (a Evolution confirmou) — não faz sentido
        // dizer que falhou pro usuário. Mas se o histórico não gravou, isso
        // precisa aparecer destacado no log, não desaparecer calado.
        if (erroGravar) {
          console.log(JSON.stringify({ event: "whatsapp_send_text_historico_falhou_apos_envio", waMessageId, erro: erroGravar.message }));
        }
      } else {
        // Envio falhou de verdade (não foi o throttle) — desfaz a reserva
        // pra não gastar uma "vaga" do limite anti-bloqueio à toa.
        await supabase.from("wa_send_log").delete().eq("id", reserva.logId);
      }
      return json(respBody ?? { error: "A Evolution API não respondeu um formato reconhecido." }, r.status);
    }

    if (action === "send-media") {
      // Foto/vídeo/documento escolhido pelo atendente no painel: o navegador
      // já subiu o arquivo pro bucket privado "wa-media" (usando a própria
      // sessão autenticada) antes de chamar esta ação — aqui só baixamos de
      // volta (com a service role, que sempre pode ler o bucket) e mandamos
      // pra Evolution API em base64, do jeito que /message/sendMedia espera
      // nas versões atuais (v2.x) — mesma ressalva de sempre: sem acesso à
      // instância real pra confirmar, então o erro da Evolution API volta
      // inteiro pra tela em vez de ser escondido.
      const { number, path, mediatype, mimetype, fileName, caption, nome } = params as {
        number?: string; path?: string; mediatype?: string; mimetype?: string;
        fileName?: string; caption?: string; nome?: string;
      };
      if (!number || !path || !mediatype) return json({ error: "Faltou número, arquivo ou tipo de mídia." }, 400);
      if (!["image", "video", "document", "audio"].includes(mediatype)) {
        return json({ error: "Tipo de mídia não suportado ainda (use image, video, document ou audio)." }, 400);
      }
      const digits = toWhatsappDigits(number);
      const reserva = await reservarEnvio(supabase, digits, nome, user.email);
      if (!reserva.ok) return json({ error: reserva.error }, 429);

      const { data: fileBlob, error: downloadError } = await supabase.storage.from("wa-media").download(path);
      if (downloadError || !fileBlob) {
        await supabase.from("wa_send_log").delete().eq("id", reserva.logId);
        return json({ error: "Não achei o arquivo enviado no Storage: " + (downloadError?.message ?? "desconhecido") }, 404);
      }
      // Segunda barreira de tamanho (a primeira é o file_size_limit do
      // bucket) — evita montar uma string base64 gigante em memória mesmo
      // que um arquivo grande de alguma forma já tenha sido aceito no
      // Storage antes dessa trava existir.
      if (fileBlob.size > MAX_MEDIA_BYTES) {
        await supabase.from("wa_send_log").delete().eq("id", reserva.logId);
        return json({ error: `Arquivo muito grande (máx. ${MAX_MEDIA_BYTES / 1024 / 1024}MB).` }, 413);
      }
      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const base64 = btoa(binary);

      const startedAt = Date.now();
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          number: digits,
          mediatype,
          mimetype: mimetype || undefined,
          fileName: fileName || undefined,
          caption: caption || undefined,
          media: base64,
        }),
      });
      const respBody = await r.json().catch(() => null);
      console.log(JSON.stringify({
        event: "whatsapp_send_media",
        instance: EVOLUTION_INSTANCE,
        numero_final: digits.slice(-4),
        mediatype,
        status_http: r.status,
        elapsed_ms: Date.now() - startedAt,
        message_id: respBody?.key?.id ?? null,
        resposta_nao_json: respBody === null,
      }));
      if (r.ok && respBody) {
        const waMessageId: string | null = respBody?.key?.id ?? null;
        const tipo = mediatype === "image" ? "imagem" : mediatype === "video" ? "video" : mediatype === "audio" ? "audio" : "documento";
        const { error: erroGravar } = await supabase.from("wa_messages").insert({
          telefone: digits, nome_contato: nome ?? null, direcao: "enviada", texto: caption || "", tipo,
          media_path: path, media_mime: mimetype ?? null,
          wa_message_id: waMessageId, created_by: user.email ?? null,
        });
        if (erroGravar) {
          console.log(JSON.stringify({ event: "whatsapp_send_media_historico_falhou_apos_envio", waMessageId, erro: erroGravar.message }));
        }
      } else {
        await supabase.from("wa_send_log").delete().eq("id", reserva.logId);
      }
      return json(respBody ?? { error: "A Evolution API não respondeu um formato reconhecido." }, r.status);
    }

    if (action === "sync-messages") {
      // Busca histórico direto da Evolution API (mensagens que já existiam
      // antes do webhook estar configurado, ou que chegaram enquanto o
      // painel estava fora do ar). Usa o endpoint /chat/findMessages, que é
      // o documentado nas versões atuais (v2.x) do projeto Evolution API
      // — mas como este ambiente não tem acesso à instância real do
      // usuário pra confirmar, qualquer resposta em formato inesperado
      // volta como erro detalhado (nunca falha silenciosamente, nem
      // inventa dado).
      const { number } = params as { number?: string };
      const where: Record<string, unknown> | undefined = number
        ? { key: { remoteJid: `${toWhatsappDigits(number)}@s.whatsapp.net` } }
        : undefined;

      // Busca em várias páginas em vez de só a primeira — uma única chamada
      // costuma devolver bem menos mensagem do que existe de verdade no
      // histórico. Pra pelo canso a Edge Function não rodar pra sempre se a
      // Evolution API não parar de devolver página, tem um teto de 10.
      const items: any[] = [];
      let paginaFormato: "page" | "offset" | null = null;
      const MAX_PAGINAS = 10;
      let ultimoStatus = 0;

      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const body: Record<string, unknown> = { limit: 200 };
        if (where) body.where = where;
        // Tenta os dois nomes de parâmetro de paginação mais comuns em APIs
        // baseadas em Prisma (como a Evolution API v2.x): "page" primeiro;
        // se a primeira página já vier vazia com "page", tenta "offset".
        if (paginaFormato === "offset") body.offset = (pagina - 1) * 200;
        else body.page = pagina;

        const r = await fetch(`${EVOLUTION_API_URL}/chat/findMessages/${EVOLUTION_INSTANCE}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => null);
        ultimoStatus = r.status;

        if (!r.ok) {
          if (pagina === 1) {
            return json({
              error: `A Evolution API respondeu ${r.status} em /chat/findMessages/${EVOLUTION_INSTANCE}. Essa versão instalada pode usar outro endpoint — confira a documentação da sua versão.`,
              detalhe: data,
            }, 502);
          }
          break; // já tinha trazido alguma coisa nas páginas anteriores, para por aqui
        }

        const pageItems: any[] | null = Array.isArray(data)
          ? data
          : Array.isArray(data?.messages)
          ? data.messages
          : Array.isArray(data?.messages?.records)
          ? data.messages.records
          : Array.isArray(data?.records)
          ? data.records
          : null;

        if (!pageItems) {
          if (pagina === 1) {
            return json({
              error: "A Evolution API respondeu, mas não num formato de lista de mensagens reconhecido. Veja 'detalhe' e me avise pra eu ajustar a leitura desse formato.",
              detalhe: data,
            }, 502);
          }
          break;
        }

        if (pageItems.length === 0) {
          // "page" pode não ser o parâmetro certo pra essa instância — tenta
          // "offset" uma vez antes de desistir, só na primeira página.
          if (pagina === 1 && paginaFormato === null) {
            paginaFormato = "offset";
            pagina = 0; // reexecuta a página 1, agora com offset
            continue;
          }
          break;
        }
        if (paginaFormato === null) paginaFormato = "page";

        items.push(...pageItems);
        if (pageItems.length < 200) break; // última página (veio menos que o limite pedido)
      }

      // Descobre de antemão quais wa_message_id já existem no banco (e com
      // qual telefone/telefone_e_lid) — serve pra (a) contar "já existentes"
      // separado de "novas" (o upsert por si só não diz se foi insert ou
      // update), e (b) proteger contra regressão: nunca deixar um
      // reprocessamento com LID não resolvido sobrescrever um telefone que
      // já tinha sido resolvido antes (aconteceu na prática).
      const idsCandidatos = items.map((it) => it?.key?.id).filter(Boolean) as string[];
      const existentesPorId = new Map<string, { telefone: string; telefone_e_lid: boolean }>();
      for (let i = 0; i < idsCandidatos.length; i += 500) {
        const lote = idsCandidatos.slice(i, i + 500);
        const { data: existentes } = await supabase.from("wa_messages").select("wa_message_id, telefone, telefone_e_lid").in("wa_message_id", lote);
        (existentes ?? []).forEach((r: { wa_message_id: string; telefone: string; telefone_e_lid: boolean }) => existentesPorId.set(r.wa_message_id, r));
      }

      // Diagnóstico opcional: dado um wa_message_id específico (que existe
      // na Evolution mas o dono desconfia que não entrou no Supabase),
      // devolve exatamente por que ele foi ou não foi salvo.
      const { debugMessageId } = params as { debugMessageId?: string };
      let debug: Record<string, unknown> | undefined;
      if (debugMessageId) {
        const achado = items.find((it) => it?.key?.id === debugMessageId);
        if (!achado) {
          debug = { encontradoNaEvolution: false, mensagem: "Esse wa_message_id não veio em nenhuma página do /chat/findMessages nesta sincronização." };
        } else {
          const tipoDebug = extractTipo(achado.message);
          // Só metadado — nunca o texto/legenda real da mensagem do
          // paciente. "chavesMensagem" mostra os nomes dos campos presentes
          // (ex.: ["viewOnceMessageV2"]), útil pra diagnosticar um formato
          // novo/desconhecido sem expor conteúdo.
          debug = {
            encontradoNaEvolution: true,
            tipo: tipoDebug,
            temTexto: !!extractText(achado.message),
            ehMidia: isMidia(tipoDebug),
            ehGrupo: (achado.key?.remoteJid || "").endsWith("@g.us"),
            fromMe: !!achado.key?.fromMe,
            telefoneExtraido: extrairTelefoneInfo(achado.key).telefone ? "***" : null,
            jaExistiaNoSupabase: existentesPorId.has(debugMessageId),
            chavesMensagem: achado.message ? Object.keys(achado.message) : [],
            messageTimestamp: achado.messageTimestamp ?? null,
          };
        }
      }

      let sincronizadas = 0;
      const motivos = {
        semKey: 0, grupo: 0, semTelefone: 0, jaExistentes: 0,
        texto: 0, imagem: 0, video: 0, audio: 0, documento: 0, figurinha: 0,
        reacaoIgnorada: 0, sistemaIgnorado: 0, formatoDesconhecido: 0, erroGravar: 0,
      };
      let primeiroErroGravar: string | null = null;
      for (const item of items) {
        if (!item?.key) { motivos.semKey++; continue; }
        const remoteJid: string = item.key.remoteJid || "";
        if (remoteJid.endsWith("@g.us")) { motivos.grupo++; continue; } // grupo do WhatsApp, não conversa de paciente
        let { telefone, ehLid } = extrairTelefoneInfo(item.key);
        if (!telefone) { motivos.semTelefone++; continue; }

        const tipo = extractTipo(item.message);
        if (tipo === "reacao") { motivos.reacaoIgnorada++; continue; }
        if (tipo === "sistema") { motivos.sistemaIgnorado++; continue; }
        const texto = extractText(item.message);
        const midia = isMidia(tipo);
        if (!texto && !midia) { motivos.formatoDesconhecido++; continue; } // formato não reconhecido, nada útil pra guardar

        const waMessageId: string | null = item.key.id || null;
        const existente = waMessageId ? existentesPorId.get(waMessageId) : undefined;
        const jaExistia = !!existente;
        // Proteção contra regressão: não deixa um LID não resolvido nessa
        // sincronização sobrescrever um telefone que já era de verdade.
        if (ehLid && existente && existente.telefone_e_lid === false) {
          telefone = existente.telefone;
          ehLid = false;
        }
        const direcao = item.key.fromMe ? "enviada" : "recebida";
        const nomeContato = item.pushName || null;
        const timestamp = item.messageTimestamp
          ? new Date(Number(item.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString();

        const { error } = waMessageId
          ? await supabase.from("wa_messages").upsert({
              telefone, nome_contato: nomeContato, direcao, texto, tipo,
              created_at: timestamp, wa_message_id: waMessageId, telefone_e_lid: ehLid,
            }, { onConflict: "wa_message_id" })
          : await supabase.from("wa_messages").insert({
              telefone, nome_contato: nomeContato, direcao, texto, tipo, created_at: timestamp, telefone_e_lid: ehLid,
            });
        if (error) {
          motivos.erroGravar++;
          if (!primeiroErroGravar) primeiroErroGravar = error.message;
        } else {
          sincronizadas++;
          if (jaExistia) motivos.jaExistentes++;
          // A essa altura tipo só pode ser texto/imagem/video/audio/documento/figurinha
          // (reacao, sistema e formato desconhecido já causaram "continue" acima).
          (motivos as Record<string, number>)[tipo]++;
        }
      }

      // Se quase nada foi salvo, manda uma amostra dos itens brutos junto —
      // sem isso não dá pra saber, sem acesso à Evolution API real, se o
      // formato de "message" é diferente do que o extractText espera.
      const amostra = sincronizadas === 0 ? items.slice(0, 3) : undefined;
      return json({
        ok: true, sincronizadas, total_recebido: items.length, motivos, primeiroErroGravar, amostra, debug,
        paginacao: { formato_usado: paginaFormato, ultimo_status: ultimoStatus },
      });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
