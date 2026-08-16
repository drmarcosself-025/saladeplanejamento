// lead-worker — onde a decisão acontece.
//
// Pipeline por mensagem elegível:
//   Policy Engine (pré) → IA (1 chamada) → Policy Engine (pós) →
//   canSendMessage() → Evolution sendText → funil + auditoria
//
// Nada aqui confia na IA: ela sugere, o código decide. Toda saída deste
// arquivo passa por evaluatePostPolicy() e canSendMessage(), sem exceção.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { assertConfig, config } from "../_shared/config.ts";
import { json, log, secretMatches } from "../_shared/http.ts";
import { analyzeMessage, type AiSuggestion } from "../_shared/ai.ts";
import { evaluatePostPolicy, evaluatePrePolicy, type PolicyCategory } from "../_shared/policy.ts";
import { canSendMessage, type SendStats } from "../_shared/ratelimit.ts";
import { resolveStage, type Stage } from "../_shared/funnel.ts";
import { sendText } from "../_shared/evolution.ts";
import type { MessageType } from "../_shared/normalize.ts";

interface LeadRow {
  id: string;
  whatsapp_id: string;
  phone: string | null;
  is_lid: boolean;
  name: string | null;
  stage: Stage;
  treatment_interest: string | null;
  automation_status: string;
  needs_human: boolean;
  conversation_summary: string | null;
}

interface MessageRow {
  id: string;
  text: string | null;
  message_type: string;
  processed: boolean;
}

interface DecisionInput {
  leadId: string;
  messageId: string;
  intent?: string | null;
  risk?: "LOW" | "MEDIUM" | "HIGH" | null;
  confidence?: number | null;
  action: "AUTO_REPLY" | "HUMAN" | "IGNORE";
  stageBefore: Stage;
  stageAfter: Stage;
  reason: string;
  replySent: boolean;
  aiRaw?: unknown;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "metodo_nao_permitido" }, 405);

  const missing = assertConfig("worker");
  if (missing.length > 0) {
    log("config_incompleta", { faltando: missing });
    return json({ error: "config_incompleta" }, 500);
  }

  if (!secretMatches(req.headers.get("x-worker-secret"), config.worker.secret)) {
    return json({ error: "nao_autorizado" }, 401);
  }

  const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: jobs, error } = await supabase.rpc("claim_jobs", { p_limit: config.worker.batchSize });
  if (error) {
    log("claim_jobs_falhou", { erro: error.message });
    return json({ error: "claim_jobs_falhou" }, 500);
  }

  const claimed = (jobs ?? []) as Array<{ job_id: number; lead_id: string; message_id: string }>;
  let processed = 0;
  let replied = 0;

  for (const job of claimed) {
    try {
      const outcome = await processJob(supabase, job.lead_id, job.message_id);
      if (outcome.replied) replied++;
      processed++;
      await supabase.rpc("finish_job", {
        p_job_id: job.job_id,
        p_ok: true,
        p_error: null,
        p_max_attempts: config.worker.maxAttempts,
        p_backoff_base: config.worker.backoffBaseSeconds,
      });
    } catch (jobError) {
      // Erro transitório (rede, IA fora do ar, timeout): volta para a fila com
      // backoff. Esgotadas as tentativas, o lead vira HUMAN_REQUIRED — nenhum
      // lead morre em silêncio dentro da fila.
      log("job_falhou", { jobId: job.job_id, erro: String(jobError) });
      await supabase.rpc("finish_job", {
        p_job_id: job.job_id,
        p_ok: false,
        p_error: String(jobError).slice(0, 500),
        p_max_attempts: config.worker.maxAttempts,
        p_backoff_base: config.worker.backoffBaseSeconds,
      });
    }
  }

  return json({ ok: true, claimed: claimed.length, processed, replied });
});

async function processJob(
  supabase: SupabaseClient,
  leadId: string,
  messageId: string,
): Promise<{ replied: boolean }> {
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, whatsapp_id, phone, is_lid, name, stage, treatment_interest, automation_status, needs_human, conversation_summary")
    .eq("id", leadId)
    .single();
  if (leadError || !lead) throw new Error(`lead_nao_encontrado: ${leadError?.message}`);

  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("id, text, message_type, processed")
    .eq("id", messageId)
    .single();
  if (messageError || !message) throw new Error(`mensagem_nao_encontrada: ${messageError?.message}`);

  const leadRow = lead as LeadRow;
  const messageRow = message as MessageRow;

  // Idempotência final: se esta mensagem já foi processada, o job é um eco.
  if (messageRow.processed) {
    log("mensagem_ja_processada", { messageId });
    return { replied: false };
  }

  const pre = evaluatePrePolicy({
    text: messageRow.text ?? "",
    messageType: messageRow.message_type as MessageType,
    automationStatus: leadRow.automation_status,
    needsHuman: leadRow.needs_human,
  });

  // ---------------------------------------------------------------------
  // Caminho sem IA: bloqueio determinístico (mídia, termo vermelho, pausa).
  // ---------------------------------------------------------------------
  if (!pre.allowAi) {
    let handoffSent = false;

    if (pre.handoffMessage) {
      const stats = await loadStats(supabase, leadRow.id);
      const gate = canSendMessage({
        stats,
        automationStatus: leadRow.automation_status,
        needsHuman: leadRow.needs_human,
        alreadyProcessed: false,
        replyText: pre.handoffMessage,
        purpose: "HANDOFF",
      });
      if (gate.allowed) {
        handoffSent = await deliver(supabase, leadRow, pre.handoffMessage);
      } else {
        log("handoff_bloqueado", { motivo: gate.reason, leadId: leadRow.id });
      }
    }

    if (pre.needsHuman) {
      await supabase
        .from("leads")
        .update({
          needs_human: true,
          automation_status: "HUMAN_REQUIRED",
          human_reason: pre.reason,
        })
        .eq("id", leadRow.id);
    }

    await recordDecision(supabase, {
      leadId: leadRow.id,
      messageId: messageRow.id,
      risk: pre.category === "RED" ? "HIGH" : pre.category === "YELLOW" ? "MEDIUM" : "LOW",
      action: pre.needsHuman ? "HUMAN" : "IGNORE",
      stageBefore: leadRow.stage,
      stageAfter: leadRow.stage,
      reason: pre.reason,
      replySent: handoffSent,
    });

    return { replied: handoffSent };
  }

  // ---------------------------------------------------------------------
  // Caminho com IA: UMA chamada, saída estruturada.
  // ---------------------------------------------------------------------
  const recent = await loadRecentMessages(supabase, leadRow.id, messageRow.id);

  const analysis = await analyzeMessage({
    category: pre.category as PolicyCategory,
    leadName: leadRow.name,
    currentStage: leadRow.stage,
    treatmentInterest: leadRow.treatment_interest,
    conversationSummary: leadRow.conversation_summary,
    recentMessages: recent,
    currentMessage: messageRow.text ?? "",
  });

  if (!analysis.ok) {
    // Falha de rede/timeout merece retry; JSON fora do contrato, não — repetir
    // a mesma pergunta ao mesmo modelo tende ao mesmo resultado.
    if (analysis.error.startsWith("chamada_falhou")) {
      throw new Error(analysis.error);
    }

    await supabase
      .from("leads")
      .update({ needs_human: true, automation_status: "HUMAN_REQUIRED", human_reason: "resposta da IA inválida" })
      .eq("id", leadRow.id);

    await recordDecision(supabase, {
      leadId: leadRow.id,
      messageId: messageRow.id,
      action: "HUMAN",
      stageBefore: leadRow.stage,
      stageAfter: leadRow.stage,
      reason: analysis.error,
      replySent: false,
      aiRaw: analysis.raw,
    });
    return { replied: false };
  }

  const suggestion: AiSuggestion = analysis.value;

  const post = evaluatePostPolicy({
    category: pre.category,
    reply: suggestion.reply,
    action: suggestion.action,
    confidence: suggestion.confidence,
    needsHuman: suggestion.needs_human,
  });

  // Duas coisas diferentes que a auditoria não pode confundir: a IA ter
  // respondido de verdade, e o lead ter recebido só a frase neutra.
  let aiReplySent = false;
  let handoffSent = false;
  let blockReason = post.reason;

  if (post.allowSend) {
    const stats = await loadStats(supabase, leadRow.id);
    const gate = canSendMessage({
      stats,
      automationStatus: leadRow.automation_status,
      needsHuman: leadRow.needs_human,
      alreadyProcessed: false,
      replyText: suggestion.reply,
      purpose: "AI_REPLY",
    });

    if (gate.allowed) {
      aiReplySent = await deliver(supabase, leadRow, suggestion.reply);
      blockReason = aiReplySent ? post.reason : "envio_falhou_na_evolution";
    } else {
      blockReason = `rate_limit:${gate.reason}`;
    }
  } else if (post.needsHuman) {
    // A IA quis responder algo que a política não autoriza (preço inventado,
    // conteúdo clínico, confiança baixa): ninguém recebe nada automático.
    const handoff = config.clinic.handoffMessage;
    const stats = await loadStats(supabase, leadRow.id);
    const gate = canSendMessage({
      stats,
      automationStatus: leadRow.automation_status,
      needsHuman: leadRow.needs_human,
      alreadyProcessed: false,
      replyText: handoff,
      purpose: "HANDOFF",
    });
    if (gate.allowed) {
      handoffSent = await deliver(supabase, leadRow, handoff);
    }
  }

  // O funil só anda quando a automação de fato conduziu a conversa. Uma frase
  // de "a equipe vai te responder" não é progresso comercial.
  const stageDecision = resolveStage(leadRow.stage, suggestion.stage, aiReplySent);

  const leadUpdate: Record<string, unknown> = {
    stage: stageDecision.stage,
    conversation_summary: suggestion.summary ?? leadRow.conversation_summary,
    treatment_interest: suggestion.treatment_interest ?? leadRow.treatment_interest,
  };

  if (post.needsHuman) {
    leadUpdate.needs_human = true;
    leadUpdate.automation_status = "HUMAN_REQUIRED";
    leadUpdate.human_reason = suggestion.human_reason ?? post.reason;
  }

  await supabase.from("leads").update(leadUpdate).eq("id", leadRow.id);

  await recordDecision(supabase, {
    leadId: leadRow.id,
    messageId: messageRow.id,
    intent: suggestion.intent,
    risk: suggestion.risk,
    confidence: suggestion.confidence,
    action: aiReplySent ? "AUTO_REPLY" : post.needsHuman ? "HUMAN" : "IGNORE",
    stageBefore: leadRow.stage,
    stageAfter: stageDecision.stage,
    reason: `${blockReason} | funil:${stageDecision.reason}${handoffSent ? " | frase_neutra_enviada" : ""}`,
    replySent: aiReplySent || handoffSent,
    aiRaw: analysis.raw,
  });

  return { replied: aiReplySent || handoffSent };
}

// ---------------------------------------------------------------------------
// Envio: reserva → envia → carimba o id.
//
// A reserva ANTES do envio existe por causa da corrida com o human takeover:
// a Evolution pode entregar o eco `fromMe` da nossa própria mensagem antes de
// gravarmos o id devolvido. Com a linha já reservada, ingest_outbound_event
// reconhece o texto e vincula, em vez de declarar intervenção humana.
// ---------------------------------------------------------------------------
async function deliver(supabase: SupabaseClient, lead: LeadRow, text: string): Promise<boolean> {
  const { data: reserved, error: reserveError } = await supabase
    .from("messages")
    .insert({
      lead_id: lead.id,
      direction: "OUT",
      sender_type: "AI",
      message_type: "TEXT",
      text,
      processed: true,
      meta: { status: "SENDING" },
    })
    .select("id")
    .single();

  if (reserveError || !reserved) throw new Error(`reserva_envio_falhou: ${reserveError?.message}`);

  // Telefone real quando existe; senão o JID que a própria Evolution entregou.
  // Um código LID nunca é "convertido" em número aqui.
  const destination = lead.phone ?? lead.whatsapp_id;
  const result = await sendText(destination, text);

  if (!result.ok) {
    await supabase.from("messages").delete().eq("id", reserved.id);
    return false;
  }

  const { error: stampError } = await supabase
    .from("messages")
    .update({ provider_message_id: result.providerMessageId, meta: { status: "SENT" } })
    .eq("id", reserved.id);

  if (stampError) {
    // Acontece se o webhook já tiver registrado esse id primeiro. A mensagem
    // foi entregue de qualquer forma — só o carimbo ficou redundante.
    log("carimbo_id_falhou", { erro: stampError.message });
  }

  await supabase
    .from("leads")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", lead.id);

  return true;
}

async function loadStats(supabase: SupabaseClient, leadId: string): Promise<SendStats> {
  const { data, error } = await supabase.rpc("get_send_stats", { p_lead_id: leadId });
  if (error) throw new Error(`get_send_stats: ${error.message}`);
  const stats = data as Partial<SendStats> | null;
  return {
    last_out_at: stats?.last_out_at ?? null,
    last_out_text: stats?.last_out_text ?? null,
    hour_count: Number(stats?.hour_count ?? 0),
    day_count: Number(stats?.day_count ?? 0),
  };
}

/** Contexto barato: resumo + últimas N mensagens. Sem embeddings, sem RAG. */
async function loadRecentMessages(
  supabase: SupabaseClient,
  leadId: string,
  currentMessageId: string,
): Promise<Array<{ direction: "IN" | "OUT"; text: string }>> {
  const { data, error } = await supabase
    .from("messages")
    .select("direction, text, created_at")
    .eq("lead_id", leadId)
    .neq("id", currentMessageId)
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(config.ai.contextMessages);

  if (error) throw new Error(`historico_falhou: ${error.message}`);

  return ((data ?? []) as Array<{ direction: "IN" | "OUT"; text: string }>)
    .reverse()
    .map((row) => ({ direction: row.direction, text: row.text }));
}

async function recordDecision(supabase: SupabaseClient, input: DecisionInput): Promise<void> {
  const { error } = await supabase.from("automation_decisions").insert({
    lead_id: input.leadId,
    message_id: input.messageId,
    intent: input.intent ?? null,
    risk: input.risk ?? null,
    confidence: input.confidence ?? null,
    action: input.action,
    stage_before: input.stageBefore,
    stage_after: input.stageAfter,
    reason: input.reason,
    reply_sent: input.replySent,
    ai_raw: input.aiRaw ?? null,
  });

  // Auditoria não pode derrubar o atendimento, mas silêncio aqui seria pior.
  if (error) log("decisao_nao_registrada", { erro: error.message, leadId: input.leadId });
}
