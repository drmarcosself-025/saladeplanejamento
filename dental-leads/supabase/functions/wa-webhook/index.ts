// wa-webhook — porta de entrada da Evolution API.
//
// Responsabilidade única: receber, normalizar, validar e PERSISTIR. Esta
// function nunca chama IA e nunca envia mensagem.
//
// Regra que vale mais que qualquer otimização (item 9): só devolver sucesso
// para a Evolution depois que a mensagem estiver gravada. Se falhar antes
// disso, devolver erro para que a Evolution reentregue — a idempotência
// (provider_message_id UNIQUE) torna a reentrega inofensiva.

import { createClient } from "npm:@supabase/supabase-js@2";
import { config, assertConfig } from "../_shared/config.ts";
import { fetchWithTimeout, json, log, secretMatches } from "../_shared/http.ts";
import {
  contentHash,
  isMedia,
  normalizeWhatsAppEvent,
  type NormalizedEvent,
} from "../_shared/normalize.ts";

declare const EdgeRuntime: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

function background(promise: Promise<unknown>): void {
  // waitUntil mantém a tarefa viva depois da resposta HTTP. Sem ele, o
  // runtime pode encerrar a execução no meio.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(promise);
  } else {
    promise.catch(() => {});
  }
}

/**
 * Espelhamento para o webhook do CRM antigo (Maison D'Or).
 *
 * A Evolution v2 aceita UMA URL de webhook por instância. Enquanto os dois
 * sistemas precisarem conviver, este projeto recebe o evento e repassa o
 * payload cru, sem tocar em uma linha do CRM antigo. É best-effort: falha aqui
 * é registrada, mas não invalida a nossa persistência. Deixe
 * LEGACY_WEBHOOK_URL vazio para desligar. Ver docs/evolution-webhook.md.
 */
async function mirrorToLegacy(rawBody: string): Promise<void> {
  if (!config.webhook.legacyUrl) return;
  try {
    const response = await fetchWithTimeout(
      config.webhook.legacyUrl,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: rawBody },
      config.webhook.legacyTimeoutMs,
    );
    log("legacy_espelhado", { status: response.status });
  } catch (error) {
    log("legacy_espelho_falhou", { erro: String(error) });
  }
}

/**
 * Dispara o worker sem esperar.
 *
 * O worker acordado aqui dorme a janela de debounce antes de tentar o claim.
 * Numa rajada, cada mensagem acorda um worker, mas só o da ÚLTIMA encontra
 * `run_after <= now()` — os outros voltam de mãos vazias. Resultado: uma
 * rajada, um turno, uma chamada de IA. O pg_cron cobre a falha deste disparo.
 */
async function triggerWorker(): Promise<void> {
  if (!config.worker.secret) {
    log("worker_secret_ausente", { detalhe: "job ficará para o cron de segurança" });
    return;
  }
  try {
    await fetchWithTimeout(
      `${config.supabase.url}/functions/v1/lead-worker`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-worker-secret": config.worker.secret },
        body: JSON.stringify({ source: "webhook" }),
      },
      20000,
    );
  } catch (error) {
    log("worker_disparo_falhou", { erro: String(error) });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "metodo_nao_permitido" }, 405);

  const missing = assertConfig("webhook");
  if (missing.length > 0) {
    log("config_incompleta", { faltando: missing });
    return json({ error: "config_incompleta" }, 500);
  }

  const received = req.headers.get("x-webhook-secret") ??
    new URL(req.url).searchParams.get("secret");
  if (!secretMatches(received, config.webhook.secret)) {
    return json({ error: "nao_autorizado" }, 401);
  }

  const rawBody = await req.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Corpo inválido não melhora com retry.
    return json({ error: "json_invalido" }, 400);
  }

  background(mirrorToLegacy(rawBody));

  const events = normalizeWhatsAppEvent(payload);
  if (events.length === 0) {
    return json({ ok: true, ignorado: "evento_nao_tratado" });
  }

  const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
    db: { schema: "dental_leads" },
  });

  let enqueued = 0;
  let takeovers = 0;
  let duplicates = 0;
  let ignored = 0;
  const failures: string[] = [];

  for (const event of events) {
    if (event.kind === "IGNORE") {
      ignored++;
      log("evento_ignorado", { motivo: event.ignoreReason });
      continue;
    }

    try {
      if (event.kind === "OUTBOUND") {
        const result = await handleOutbound(supabase, event);
        if (result?.takeover) takeovers++;
        continue;
      }

      const result = await handleInbound(supabase, event);
      if (result?.duplicate) duplicates++;
      if (result?.enqueued) enqueued++;
    } catch (error) {
      // Falha ANTES da persistência: registra e devolve 5xx no fim, para que
      // a Evolution reentregue o evento.
      failures.push(String(error));
      log("persistencia_falhou", { erro: String(error), tipo: event.kind });
    }
  }

  if (failures.length > 0) {
    return json({ error: "persistencia_falhou", detalhes: failures.length }, 500);
  }

  if (enqueued > 0) background(triggerWorker());

  log("webhook_ok", { enqueued, takeovers, duplicates, ignored });
  return json({ ok: true, enqueued, takeovers, duplicates, ignored });
});

async function handleInbound(
  supabase: ReturnType<typeof createClient>,
  event: NormalizedEvent,
): Promise<{ duplicate: boolean; enqueued: boolean }> {
  // Mídia nunca vai para a IA na V1 (item 14): marca pendência humana já na
  // entrada, antes de qualquer custo. Figurinha é exceção — é enfeite de
  // conversa, não conteúdo clínico.
  const mediaNeedsHuman = event.messageType !== "STICKER" &&
    (isMedia(event.messageType) ||
      event.messageType === "LOCATION" ||
      event.messageType === "CONTACT");

  const { data, error } = await supabase.rpc("ingest_inbound_message", {
    p_whatsapp_id: event.whatsappId,
    p_phone: event.phone,
    p_is_lid: event.isLid,
    p_name: event.name,
    p_provider_message_id: event.providerMessageId,
    p_message_type: event.messageType,
    p_text: event.text,
    p_meta: event.meta,
    // Relógio do WhatsApp vai para provider_timestamp; a ordem cronológica
    // que o motor usa é o received_at gravado pelo próprio banco.
    p_provider_timestamp: event.occurredAt,
    p_content_hash: event.text ? await contentHash(event.text) : null,
    p_reply_to_provider_id: event.replyToProviderId,
    p_links: event.links.length > 0 ? event.links : null,
    p_needs_human: mediaNeedsHuman,
    p_human_reason: mediaNeedsHuman ? `mensagem de ${event.messageType.toLowerCase()} recebida` : null,
    // O debounce vive na transação de entrada: cada mensagem empurra a janela,
    // sem nunca ultrapassar o teto contado desde o início da rajada.
    p_debounce_seconds: config.turn.debounceSeconds,
    p_debounce_max_wait: config.turn.debounceMaxWaitSeconds,
  });

  if (error) throw new Error(`ingest_inbound_message: ${error.message}`);

  const result = data as { duplicate?: boolean; enqueued?: boolean } | null;
  return { duplicate: result?.duplicate === true, enqueued: result?.enqueued === true };
}

async function handleOutbound(
  supabase: ReturnType<typeof createClient>,
  event: NormalizedEvent,
): Promise<{ takeover: boolean }> {
  const { data, error } = await supabase.rpc("ingest_outbound_event", {
    p_whatsapp_id: event.whatsappId,
    p_phone: event.phone,
    p_is_lid: event.isLid,
    p_name: event.name,
    p_provider_message_id: event.providerMessageId,
    p_message_type: event.messageType,
    p_text: event.text,
    p_meta: event.meta,
    p_occurred_at: event.occurredAt,
    p_grace_seconds: config.worker.takeoverGraceSeconds,
    // Casa o eco da nossa própria bolha por hash, não só por texto.
    p_content_hash: event.text ? await contentHash(event.text) : null,
  });

  if (error) throw new Error(`ingest_outbound_event: ${error.message}`);

  const result = data as { takeover?: boolean; reason?: string } | null;
  if (result?.takeover) {
    log("human_takeover", { motivo: result.reason });
  }
  return { takeover: result?.takeover === true };
}
