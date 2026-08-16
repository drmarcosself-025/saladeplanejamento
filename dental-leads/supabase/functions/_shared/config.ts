// Configuração centralizada. Nenhum limite, timeout ou credencial deve
// aparecer solto no resto do código — se um número novo for necessário, ele
// nasce aqui, com default conservador e nome de env explícito.

function env(name: string, fallback = ""): string {
  return (Deno.env.get(name) ?? fallback).trim();
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  supabase: {
    url: env("SUPABASE_URL"),
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  },

  evolution: {
    apiUrl: env("EVOLUTION_API_URL").replace(/\/+$/, ""),
    apiKey: env("EVOLUTION_API_KEY"),
    instance: env("EVOLUTION_INSTANCE"),
    // Delay que a própria Evolution aplica antes de entregar (simula digitação
    // e reduz o padrão robótico que leva a bloqueio de número).
    sendDelayMs: num("EVOLUTION_SEND_DELAY_MS", 1500),
    timeoutMs: num("EVOLUTION_TIMEOUT_MS", 15000),
  },

  webhook: {
    secret: env("WEBHOOK_SECRET"),
    // Espelhamento para o webhook do CRM antigo. Vazio = desligado.
    // Ver docs/evolution-webhook.md antes de ligar isso.
    legacyUrl: env("LEGACY_WEBHOOK_URL"),
    legacyTimeoutMs: num("LEGACY_WEBHOOK_TIMEOUT_MS", 4000),
  },

  worker: {
    secret: env("WORKER_SECRET"),
    batchSize: num("WORKER_BATCH_SIZE", 5),
    maxAttempts: num("WORKER_MAX_ATTEMPTS", 4),
    backoffBaseSeconds: num("WORKER_BACKOFF_BASE_SECONDS", 120),
    // Janela em que um evento fromMe com texto idêntico ao que acabamos de
    // enviar é tratado como eco da nossa mensagem, não como intervenção
    // humana. Ver ARQUITETURA.md seção G.
    takeoverGraceSeconds: num("TAKEOVER_GRACE_SECONDS", 120),
  },

  ai: {
    provider: env("AI_PROVIDER", "anthropic").toLowerCase(),
    apiKey: env("AI_API_KEY"),
    model: env("AI_MODEL", "claude-haiku-4-5-20251001"),
    // Só necessário para provedores compatíveis com OpenAI que não são a
    // própria OpenAI (DeepSeek, Groq, OpenRouter...).
    baseUrl: env("AI_BASE_URL"),
    timeoutMs: num("AI_TIMEOUT_MS", 20000),
    maxTokens: num("AI_MAX_TOKENS", 700),
    temperature: num("AI_TEMPERATURE", 0.4),
    // Abaixo disso a sugestão da IA não vira envio automático.
    minConfidence: num("AI_MIN_CONFIDENCE", 0.6),
    // Quantas mensagens recentes acompanham o resumo no contexto.
    contextMessages: num("AI_CONTEXT_MESSAGES", 8),
    maxReplyChars: num("AI_MAX_REPLY_CHARS", 600),
  },

  rateLimit: {
    minIntervalSeconds: num("RATE_LIMIT_MIN_INTERVAL", 20),
    hourly: num("RATE_LIMIT_HOURLY", 8),
    daily: num("RATE_LIMIT_DAILY", 30),
  },

  clinic: {
    name: env("CLINIC_NAME", "a clínica"),
    city: env("CLINIC_CITY", ""),
    address: env("CLINIC_ADDRESS", ""),
    hours: env("CLINIC_HOURS", ""),
    // Tratamentos que a IA pode mencionar. Fora disso ela não inventa.
    treatments: env(
      "CLINIC_TREATMENTS",
      "Invisalign, aparelho ortodôntico, clareamento, lentes e facetas, implante, limpeza",
    ),
    // Resposta neutra e pré-autorizada usada quando o caso vira humano. Texto
    // fixo — nunca gerado por IA.
    handoffMessage: env(
      "CLINIC_HANDOFF_MESSAGE",
      "Vou pedir para alguém da nossa equipe te responder por aqui, tá? 🙏",
    ),
  },
} as const;

// Falha cedo e com mensagem clara, em vez de erro obscuro no meio do fluxo.
export function assertConfig(scope: "webhook" | "worker"): string[] {
  const missing: string[] = [];
  if (!config.supabase.url) missing.push("SUPABASE_URL");
  if (!config.supabase.serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!config.webhook.secret && scope === "webhook") missing.push("WEBHOOK_SECRET");
  if (scope === "worker") {
    if (!config.worker.secret) missing.push("WORKER_SECRET");
    if (!config.ai.apiKey) missing.push("AI_API_KEY");
    if (!config.evolution.apiUrl) missing.push("EVOLUTION_API_URL");
    if (!config.evolution.apiKey) missing.push("EVOLUTION_API_KEY");
    if (!config.evolution.instance) missing.push("EVOLUTION_INSTANCE");
  }
  return missing;
}
