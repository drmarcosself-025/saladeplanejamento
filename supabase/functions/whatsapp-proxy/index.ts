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
      const { number, text } = params as { number?: string; text?: string };
      if (!number || !text) return json({ error: "Faltou número ou texto." }, 400);
      const digits = String(number).replace(/\D/g, "");
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ number: digits, text }),
      });
      return json(await r.json(), r.status);
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
