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
// independente, sem importar arquivo de outra function).
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
function extractTipo(message: any): string {
  if (!message) return "outro";
  if (message.conversation || message.extendedTextMessage || message.text) return "texto";
  if (message.imageMessage) return "imagem";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.stickerMessage) return "figurinha";
  return "outro";
}

// Mesma regra do waLink() no index.html: número sem código de país (55) é
// inválido pro WhatsApp verificar ("exists: false"), mesmo sendo um número
// de verdade — confirmado com o teste real do usuário.
function toWhatsappDigits(number: string): string {
  const digits = String(number || "").replace(/\D/g, "");
  return digits.startsWith("55") ? digits : "55" + digits;
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const EVOLUTION_API_URL = Deno.env.get("EVOLUTION_API_URL") ?? "";
  const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
  const EVOLUTION_INSTANCE = Deno.env.get("EVOLUTION_INSTANCE") ?? "consultorio";

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

    if (action === "send-text") {
      const { number, text, nome } = params as { number?: string; text?: string; nome?: string };
      if (!number || !text) return json({ error: "Faltou número ou texto." }, 400);

      // O painel nunca chama esta ação hoje (ele só abre um link wa.me pro
      // atendente clicar em enviar) — mas a ação existe e qualquer pessoa
      // com uma sessão válida poderia chamá-la direto, sem passar pela
      // checagem de intervalo/limite que existe no navegador. Por isso a
      // política anti-bloqueio é reforçada aqui também, no servidor, e não
      // só no index.html.
      const { data: cfg } = await supabase
        .from("config")
        .select("wa_intervalo_min_seg, wa_intervalo_max_seg, wa_limite_hora, wa_limite_dia")
        .eq("id", 1)
        .single();
      const minSeg = cfg?.wa_intervalo_min_seg ?? 20;
      const maxSeg = Math.max(minSeg, cfg?.wa_intervalo_max_seg ?? 50);
      const limiteHora = cfg?.wa_limite_hora ?? 30;
      const limiteDia = cfg?.wa_limite_dia ?? 120;

      const umDiaAtras = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: logs } = await supabase
        .from("wa_send_log")
        .select("created_at")
        .gte("created_at", umDiaAtras)
        .order("created_at", { ascending: false });

      if (logs && logs.length) {
        const ultimoEnvio = new Date(logs[0].created_at).getTime();
        const esperar = (minSeg + Math.random() * (maxSeg - minSeg)) * 1000;
        if (Date.now() - ultimoEnvio < esperar) {
          return json({ error: "Aguarde antes da próxima mensagem (proteção contra bloqueio do WhatsApp)." }, 429);
        }
        const umaHoraAtras = Date.now() - 60 * 60 * 1000;
        if (logs.filter((l: { created_at: string }) => new Date(l.created_at).getTime() > umaHoraAtras).length >= limiteHora) {
          return json({ error: `Limite de ${limiteHora} mensagens por hora atingido.` }, 429);
        }
        if (logs.length >= limiteDia) {
          return json({ error: `Limite de ${limiteDia} mensagens no dia atingido.` }, 429);
        }
      }

      const digits = toWhatsappDigits(number);
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ number: digits, text }),
      });
      const respBody = await r.json();
      if (r.ok) {
        // Grava aqui (no servidor), não no navegador — assim o histórico
        // fica correto mesmo se o navegador do atendente fechar ou cair
        // logo depois do envio já ter sido confirmado pela Evolution API.
        const waMessageId: string | null = respBody?.key?.id ?? null;
        await supabase.from("wa_send_log").insert({ telefone: digits, nome: nome ?? null, created_by: user.email ?? null });
        await supabase.from("wa_messages").insert({
          telefone: digits, nome_contato: nome ?? null, direcao: "enviada", texto: text,
          wa_message_id: waMessageId, created_by: user.email ?? null,
        });
      }
      return json(respBody, r.status);
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

      let sincronizadas = 0;
      const motivos = { semKey: 0, semTelefone: 0, semTexto: 0, erroGravar: 0, grupo: 0 };
      let primeiroErroGravar: string | null = null;
      for (const item of items) {
        if (!item?.key) { motivos.semKey++; continue; }
        const remoteJid: string = item.key.remoteJid || "";
        if (remoteJid.endsWith("@g.us")) { motivos.grupo++; continue; } // grupo do WhatsApp, não conversa de paciente
        const telefone = remoteJid.split("@")[0];
        if (!telefone) { motivos.semTelefone++; continue; }
        const texto = extractText(item.message);
        if (!texto) { motivos.semTexto++; continue; }
        const waMessageId: string | null = item.key.id || null;
        const direcao = item.key.fromMe ? "enviada" : "recebida";
        const nomeContato = item.pushName || null;
        const timestamp = item.messageTimestamp
          ? new Date(Number(item.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString();
        const tipo = extractTipo(item.message);

        const { error } = waMessageId
          ? await supabase.from("wa_messages").upsert({
              telefone, nome_contato: nomeContato, direcao, texto, tipo,
              created_at: timestamp, wa_message_id: waMessageId,
            }, { onConflict: "wa_message_id" })
          : await supabase.from("wa_messages").insert({
              telefone, nome_contato: nomeContato, direcao, texto, tipo, created_at: timestamp,
            });
        if (error) {
          motivos.erroGravar++;
          if (!primeiroErroGravar) primeiroErroGravar = error.message;
        } else {
          sincronizadas++;
        }
      }

      // Se quase nada foi salvo, manda uma amostra dos itens brutos junto —
      // sem isso não dá pra saber, sem acesso à Evolution API real, se o
      // formato de "message" é diferente do que o extractText espera.
      const amostra = sincronizadas === 0 ? items.slice(0, 3) : undefined;
      return json({
        ok: true, sincronizadas, total_recebido: items.length, motivos, primeiroErroGravar, amostra,
        paginacao: { formato_usado: paginaFormato, ultimo_status: ultimoStatus },
      });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
