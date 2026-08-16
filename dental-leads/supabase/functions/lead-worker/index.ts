// lead-worker — orquestrador de TURNO.
//
// Um turno é tudo que o lead falou desde a última resposta. O pipeline:
//
//   claim (lock por lead) → batch cronológico → Policy Engine (pré) →
//   1 chamada de IA → Policy Engine (pós) → assertTurnStillValid →
//   rate limit → delay natural → assertTurnStillValid → envio →
//   funil + resumo → decisão auditável → close_turn
//
// Nada aqui confia na IA, e nada sai sem que o turno seja validado de novo
// imediatamente antes do envio: entre pensar e falar, a conversa pode ter
// mudado.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { assertConfig, config } from "../_shared/config.ts";
import { json, log, secretMatches } from "../_shared/http.ts";
import { analyzeMessage, type AiSuggestion } from "../_shared/ai.ts";
import { evaluatePostPolicy, evaluatePrePolicy } from "../_shared/policy.ts";
import { canSendMessage, type TurnStats } from "../_shared/ratelimit.ts";
import { resolveStage, type Stage } from "../_shared/funnel.ts";
import { sendText } from "../_shared/evolution.ts";
import { contentHash, type MessageType } from "../_shared/normalize.ts";
import {
  assertTurnStillValid,
  type BatchMessage,
  type ClaimedTurn,
  claimTurns,
  closeTurn,
  fetchBatch,
  naturalDelayMs,
  newWorkerId,
  outcomeForInvalidTurn,
  reclaimExpiredJobs,
  renewLease,
  reserveOutboundBubble,
  type SendPurpose,
  sleep,
  type TurnOutcome,
} from "../_shared/turn.ts";

interface LeadRow {
  id: string;
  whatsapp_id: string;
  phone: string | null;
  name: string | null;
  stage: Stage;
  treatment_interest: string | null;
  automation_status: string;
  needs_human: boolean;
  conversation_summary: string | null;
}

interface DecisionInput {
  leadId: string;
  turnId: string;
  batchIds: string[];
  inputRevision: number;
  intent?: string | null;
  risk?: "LOW" | "MEDIUM" | "HIGH" | null;
  confidence?: number | null;
  action: "AUTO_REPLY" | "HUMAN" | "IGNORE";
  stageBefore: Stage;
  stageAfter: Stage;
  reason: string;
  replySent: boolean;
  bubblesSent: number;
  outcome: TurnOutcome;
  aiRaw?: unknown;
}

interface TurnResult {
  outcome: TurnOutcome;
  replied: boolean;
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

  const startedAt = Date.now();
  const workerId = newWorkerId();
  const body = await req.json().catch(() => ({}));
  const source = String((body as Record<string, unknown>)?.source ?? "desconhecido");

  const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Acordado pelo webhook: espera a janela de debounce antes de tentar pegar
  // o turno. Numa rajada, só o worker da última mensagem encontra trabalho —
  // os outros voltam vazios, e isso é o comportamento desejado.
  if (source === "webhook") {
    const waitMs = Math.min(
      config.turn.debounceSeconds * 1000 + 500,
      config.worker.maxWaitMs,
    );
    await sleep(waitMs);
  }

  // Worker morto (deploy, timeout, crash) devolve o turno para a fila.
  await reclaimExpiredJobs(supabase);

  let turns: ClaimedTurn[];
  try {
    turns = await claimTurns(supabase, workerId);
  } catch (error) {
    log("claim_falhou", { erro: String(error) });
    return json({ error: "claim_falhou" }, 500);
  }

  if (turns.length === 0) {
    return json({ ok: true, claimed: 0, source });
  }

  // Turnos claimados são de leads distintos por construção (lock por lead),
  // então rodam em paralelo sem risco de cruzar conversa.
  const results = await Promise.all(
    turns.map((turn) => runTurnSafely(supabase, workerId, turn)),
  );

  const summary = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.outcome] = (acc[result.outcome] ?? 0) + 1;
    return acc;
  }, {});

  log("worker_ok", { source, claimed: turns.length, ms: Date.now() - startedAt, ...summary });
  return json({ ok: true, claimed: turns.length, outcomes: summary });
});

async function runTurnSafely(
  supabase: SupabaseClient,
  workerId: string,
  turn: ClaimedTurn,
): Promise<TurnResult> {
  try {
    return await runTurn(supabase, workerId, turn);
  } catch (error) {
    // Erro transitório: volta para a fila com backoff. O batch permanece não
    // processado, então o próximo turno reúne tudo de novo.
    log("turno_falhou", { jobId: turn.jobId, erro: String(error) });
    await closeTurn(supabase, {
      jobId: turn.jobId,
      workerId,
      outcome: "FAILED",
      batchIds: [],
      markProcessed: false,
      error: String(error).slice(0, 500),
    });
    return { outcome: "FAILED", replied: false };
  }
}

async function runTurn(
  supabase: SupabaseClient,
  workerId: string,
  turn: ClaimedTurn,
): Promise<TurnResult> {
  const lead = await loadLead(supabase, turn.leadId);

  const { messages: batch, revision }: { messages: BatchMessage[]; revision: number } =
    await fetchBatch(supabase, turn.leadId);
  const batchIds = batch.map((message) => message.id);

  // Turno sem trabalho: o takeover ou um turno anterior já consumiu as
  // mensagens. Fecha sem tocar em nada.
  if (batch.length === 0) {
    await closeTurn(supabase, {
      jobId: turn.jobId,
      workerId,
      outcome: "NO_REPLY",
      batchIds: [],
      markProcessed: false,
    });
    return { outcome: "NO_REPLY", replied: false };
  }

  const batchText = batch
    .map((message) => (message.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const batchTypes = batch.map((message) => message.message_type as MessageType);

  const pre = evaluatePrePolicy({
    text: batchText,
    messageTypes: batchTypes,
    automationStatus: lead.automation_status,
    needsHuman: lead.needs_human,
  });

  // -------------------------------------------------------------------
  // Caminho sem IA: bloqueio determinístico (figurinha solta, mídia,
  // termo vermelho, automação pausada).
  // -------------------------------------------------------------------
  if (!pre.allowAi) {
    let bubblesSent = 0;

    if (pre.handoffMessage) {
      const delivered = await deliver(supabase, {
        lead,
        turnId: turn.turnId,
        jobId: turn.jobId,
        workerId,
        batchIds,
        revision,
        text: pre.handoffMessage,
        sequence: 1,
        purpose: "HANDOFF",
        // Handoff clínico não espera: quem está com dor não pode ficar
        // olhando para o silêncio por 5 segundos.
        delayMs: 0,
      });
      if (delivered.status === "SENT") bubblesSent = 1;

      if (delivered.status === "STALE") {
        // Nada saiu: o batch volta inteiro para o próximo turno.
        const outcome = outcomeForInvalidTurn(delivered.reason ?? "stale", 0);
        await recordDecision(supabase, {
          leadId: lead.id,
          turnId: turn.turnId,
          batchIds,
      inputRevision: revision,
          action: "IGNORE",
          stageBefore: lead.stage,
          stageAfter: lead.stage,
          reason: `handoff_descartado:${delivered.reason}`,
          replySent: false,
          bubblesSent: 0,
          outcome,
        });
        await finish(supabase, workerId, turn, batchIds, outcome, false);
        return { outcome, replied: false };
      }

      if (delivered.status === "UNKNOWN") {
        await markUnknownSend(supabase, lead.id);
        await finish(supabase, workerId, turn, batchIds, "SEND_UNKNOWN", true);
        await recordDecision(supabase, {
          leadId: lead.id,
          turnId: turn.turnId,
          batchIds,
      inputRevision: revision,
          action: "HUMAN",
          stageBefore: lead.stage,
          stageAfter: lead.stage,
          reason: `${pre.reason} | envio_incerto`,
          replySent: false,
          bubblesSent: 0,
          outcome: "SEND_UNKNOWN",
        });
        return { outcome: "SEND_UNKNOWN", replied: false };
      }
    }

    if (pre.needsHuman) {
      await supabase
        .from("leads")
        .update({ needs_human: true, automation_status: "HUMAN_REQUIRED", human_reason: pre.reason })
        .eq("id", lead.id);
    }

    const outcome: TurnOutcome = bubblesSent > 0 ? "COMPLETED" : "NO_REPLY";
    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      risk: pre.category === "RED" ? "HIGH" : pre.category === "YELLOW" ? "MEDIUM" : "LOW",
      action: pre.needsHuman ? "HUMAN" : "IGNORE",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      reason: pre.reason,
      replySent: bubblesSent > 0,
      bubblesSent,
      outcome,
    });

    // Mesmo sem resposta, o batch foi decidido: marcá-lo como processado
    // evita reprocessar a mesma figurinha/mídia para sempre.
    await finish(supabase, workerId, turn, batchIds, outcome, true);
    return { outcome, replied: bubblesSent > 0 };
  }

  // -------------------------------------------------------------------
  // Caminho com IA: UMA chamada para a rajada inteira.
  // -------------------------------------------------------------------
  const history = await loadHistory(supabase, lead.id, batchIds);

  const analysis = await analyzeMessage({
    category: pre.category,
    leadName: lead.name,
    currentStage: lead.stage,
    treatmentInterest: lead.treatment_interest,
    conversationSummary: lead.conversation_summary,
    recentMessages: history,
    currentMessages: batch.map((message) => (message.text ?? "").trim()).filter(Boolean),
  });

  // Heartbeat depois da operação mais longa do turno.
  if (!await renewLease(supabase, turn.jobId, workerId)) {
    log("lease_perdido_pos_ia", { jobId: turn.jobId });
    await finish(supabase, workerId, turn, batchIds, "STALE_BEFORE_SEND", false);
    return { outcome: "STALE_BEFORE_SEND", replied: false };
  }

  if (!analysis.ok) {
    // Rede/timeout merece retry; JSON fora do contrato não — repetir a mesma
    // pergunta ao mesmo modelo tende ao mesmo resultado.
    if (analysis.error.startsWith("chamada_falhou")) {
      throw new Error(analysis.error);
    }

    await supabase
      .from("leads")
      .update({ needs_human: true, automation_status: "HUMAN_REQUIRED", human_reason: "resposta da IA inválida" })
      .eq("id", lead.id);

    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      action: "HUMAN",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      reason: analysis.error,
      replySent: false,
      bubblesSent: 0,
      outcome: "NO_REPLY",
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, "NO_REPLY", true);
    return { outcome: "NO_REPLY", replied: false };
  }

  const suggestion: AiSuggestion = analysis.value;

  const post = evaluatePostPolicy({
    category: pre.category,
    reply: suggestion.reply,
    action: suggestion.action,
    confidence: suggestion.confidence,
    needsHuman: suggestion.needs_human,
  });

  const purpose: SendPurpose = post.allowSend ? "AI_REPLY" : "HANDOFF";
  const textToSend = post.allowSend ? suggestion.reply : config.clinic.handoffMessage;

  // Nada será enviado neste turno: a IA pediu para ignorar e não há motivo
  // para frase neutra.
  if (!post.allowSend && !post.needsHuman) {
    await applyLeadUpdate(supabase, lead, suggestion, lead.stage, post.needsHuman, post.reason);
    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      intent: suggestion.intent,
      risk: suggestion.risk,
      confidence: suggestion.confidence,
      action: "IGNORE",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      reason: post.reason,
      replySent: false,
      bubblesSent: 0,
      outcome: "NO_REPLY",
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, "NO_REPLY", true);
    return { outcome: "NO_REPLY", replied: false };
  }

  // --- Checagem 1: a resposta recém-gerada ainda vale? -----------------
  const afterAi = await assertTurnStillValid(supabase, {
    jobId: turn.jobId,
    workerId,
    leadId: lead.id,
    batchIds,
    inputRevision: revision,
    purpose,
  });

  if (!afterAi.valid) {
    // Nenhuma bolha saiu: o batch NÃO é marcado como processado, então o
    // próximo turno junta mensagens antigas e novas e responde uma vez só.
    const outcome = outcomeForInvalidTurn(afterAi.reason, 0);
    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      intent: suggestion.intent,
      risk: suggestion.risk,
      confidence: suggestion.confidence,
      action: "IGNORE",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      // Decisão obsoleta não é aplicada: resumo, etapa e interesse ficam como
      // estavam. O próximo turno recalcula a partir do histórico real.
      reason: `descartada_pos_ia:${afterAi.reason}`,
      replySent: false,
      bubblesSent: 0,
      outcome,
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, outcome, false);
    return { outcome, replied: false };
  }

  // --- Rate limit (por turno, nunca por bolha) -------------------------
  const stats = await loadTurnStats(supabase, lead.id);
  const gate = canSendMessage({
    stats,
    automationStatus: lead.automation_status,
    needsHuman: lead.needs_human,
    replyText: textToSend,
    purpose,
  });

  if (!gate.allowed) {
    if (post.needsHuman) await markNeedsHuman(supabase, lead.id, suggestion.human_reason ?? post.reason);
    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      intent: suggestion.intent,
      risk: suggestion.risk,
      confidence: suggestion.confidence,
      action: post.needsHuman ? "HUMAN" : "IGNORE",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      reason: `rate_limit:${gate.reason}`,
      replySent: false,
      bubblesSent: 0,
      outcome: "NO_REPLY",
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, "NO_REPLY", true);
    return { outcome: "NO_REPLY", replied: false };
  }

  // --- Envio (delay natural + checagem 2 dentro do deliver) ------------
  const delivered = await deliver(supabase, {
    lead,
    turnId: turn.turnId,
    jobId: turn.jobId,
    workerId,
    batchIds,
    revision,
    text: textToSend,
    sequence: 1,
    purpose,
    delayMs: purpose === "HANDOFF"
      ? 0
      : naturalDelayMs(config.turn.responseDelayMinMs, config.turn.responseDelayMaxMs),
  });

  if (delivered.status === "STALE") {
    const outcome = outcomeForInvalidTurn(delivered.reason ?? "stale", 0);
    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      intent: suggestion.intent,
      risk: suggestion.risk,
      confidence: suggestion.confidence,
      action: "IGNORE",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      reason: `descartada_antes_do_envio:${delivered.reason}`,
      replySent: false,
      bubblesSent: 0,
      outcome,
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, outcome, false);
    return { outcome, replied: false };
  }

  if (delivered.status === "UNKNOWN") {
    await markUnknownSend(supabase, lead.id);
    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      intent: suggestion.intent,
      risk: suggestion.risk,
      confidence: suggestion.confidence,
      action: "HUMAN",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      reason: "envio_incerto:nunca_reenviar_automaticamente",
      replySent: false,
      bubblesSent: 0,
      outcome: "SEND_UNKNOWN",
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, "SEND_UNKNOWN", true);
    return { outcome: "SEND_UNKNOWN", replied: false };
  }

  const sent = delivered.status === "SENT";
  const aiReplySent = sent && purpose === "AI_REPLY";

  // O funil só anda quando a automação de fato conduziu a conversa. Frase
  // neutra de "a equipe vai te responder" não é progresso comercial.
  const stageDecision = resolveStage(lead.stage, suggestion.stage, aiReplySent);

  await applyLeadUpdate(
    supabase,
    lead,
    suggestion,
    stageDecision.stage,
    post.needsHuman,
    suggestion.human_reason ?? post.reason,
    sent,
  );

  await recordDecision(supabase, {
    leadId: lead.id,
    turnId: turn.turnId,
    batchIds,
      inputRevision: revision,
    intent: suggestion.intent,
    risk: suggestion.risk,
    confidence: suggestion.confidence,
    action: aiReplySent ? "AUTO_REPLY" : post.needsHuman ? "HUMAN" : "IGNORE",
    stageBefore: lead.stage,
    stageAfter: stageDecision.stage,
    reason: `${post.reason} | funil:${stageDecision.reason}`,
    replySent: sent,
    bubblesSent: sent ? 1 : 0,
    outcome: sent ? "COMPLETED" : "NO_REPLY",
    aiRaw: analysis.raw,
  });

  await finish(supabase, workerId, turn, batchIds, sent ? "COMPLETED" : "NO_REPLY", true);
  return { outcome: sent ? "COMPLETED" : "NO_REPLY", replied: sent };
}

// ---------------------------------------------------------------------------
// Envio de uma bolha.
//
// Ordem obrigatória: delay natural → reserva ATÔMICA (checa posse do lease +
// revisão + takeover + duplicidade e grava, tudo numa transação só) → POST na
// Evolution → carimbo do id.
//
// reserveOutboundBubble fecha a janela que uma checagem-e-depois-grava em
// duas chamadas separadas deixaria aberta: entre confirmar que ainda temos o
// lead e efetivamente escrever a bolha, não existe mais intervalo em que um
// worker que já perdeu a posse consiga gravar mesmo assim.
// ---------------------------------------------------------------------------
interface DeliverInput {
  lead: LeadRow;
  turnId: string;
  jobId: number;
  workerId: string;
  batchIds: string[];
  revision: number;
  text: string;
  sequence: number;
  purpose: SendPurpose;
  delayMs: number;
}

interface DeliverResult {
  status: "SENT" | "FAILED" | "UNKNOWN" | "STALE" | "DUPLICATE";
  reason?: string;
}

async function deliver(supabase: SupabaseClient, input: DeliverInput): Promise<DeliverResult> {
  if (input.delayMs > 0) await sleep(input.delayMs);

  const hash = await contentHash(input.text);

  const reservation = await reserveOutboundBubble(supabase, {
    jobId: input.jobId,
    workerId: input.workerId,
    leadId: input.lead.id,
    inputRevision: input.revision,
    batchIds: input.batchIds,
    purpose: input.purpose,
    turnId: input.turnId,
    sequence: input.sequence,
    text: input.text,
    contentHash: hash,
  });

  if (!reservation.reserved) {
    if (reservation.reason === "duplicado") {
      log("bolha_duplicada_evitada", { leadId: input.lead.id, turnId: input.turnId });
      return { status: "DUPLICATE" };
    }
    return { status: "STALE", reason: reservation.reason };
  }

  const messageId = reservation.messageId!;

  // Telefone real quando existe; senão o JID que a própria Evolution
  // entregou. Um código LID nunca é "convertido" em número aqui.
  const result = await sendText(input.lead.phone ?? input.lead.whatsapp_id, input.text);

  if (result.status === "FAILED") {
    // Recusa explícita: a mensagem não saiu. A linha vira registro de falha,
    // não fantasma de mensagem enviada.
    await supabase.from("messages").update({ send_status: "FAILED" }).eq("id", messageId);
    return { status: "FAILED", reason: result.error };
  }

  const { error: stampError } = await supabase
    .from("messages")
    .update({ send_status: result.status, provider_message_id: result.providerMessageId })
    .eq("id", messageId);

  // Acontece se o webhook já registrou esse id primeiro (eco do fromMe). A
  // mensagem foi entregue de qualquer forma — só o carimbo ficou redundante.
  if (stampError) log("carimbo_id_falhou", { erro: stampError.message });

  if (result.status === "SENT") {
    await supabase
      .from("leads")
      .update({ last_message_at: new Date().toISOString(), last_outbound_at: new Date().toISOString() })
      .eq("id", input.lead.id);
  }

  return { status: result.status, reason: result.error };
}

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------
async function loadLead(supabase: SupabaseClient, leadId: string): Promise<LeadRow> {
  const { data, error } = await supabase
    .from("leads")
    .select("id, whatsapp_id, phone, name, stage, treatment_interest, automation_status, needs_human, conversation_summary")
    .eq("id", leadId)
    .single();
  if (error || !data) throw new Error(`lead_nao_encontrado: ${error?.message}`);
  return data as LeadRow;
}

/** Contexto barato: resumo + últimas N mensagens. Sem embeddings, sem RAG. */
async function loadHistory(
  supabase: SupabaseClient,
  leadId: string,
  batchIds: string[],
): Promise<Array<{ direction: "IN" | "OUT"; text: string }>> {
  const { data, error } = await supabase
    .from("messages")
    .select("direction, text, received_at, id")
    .eq("lead_id", leadId)
    .not("text", "is", null)
    // Bolhas canceladas nunca chegaram ao lead: não podem virar memória.
    // (mensagens recebidas têm send_status nulo — o `or` preserva elas)
    .or("send_status.is.null,send_status.neq.CANCELLED")
    .order("received_at", { ascending: false })
    .limit(config.ai.contextMessages + batchIds.length);

  if (error) throw new Error(`historico_falhou: ${error.message}`);

  return ((data ?? []) as Array<{ direction: "IN" | "OUT"; text: string; id: string }>)
    .filter((row) => !batchIds.includes(row.id))
    .slice(0, config.ai.contextMessages)
    .reverse()
    .map((row) => ({ direction: row.direction, text: row.text }));
}

async function loadTurnStats(supabase: SupabaseClient, leadId: string): Promise<TurnStats> {
  const { data, error } = await supabase.rpc("get_turn_stats", { p_lead_id: leadId });
  if (error) throw new Error(`get_turn_stats: ${error.message}`);
  const stats = data as Partial<TurnStats> | null;
  return {
    last_turn_at: stats?.last_turn_at ?? null,
    last_out_text: stats?.last_out_text ?? null,
    turn_hour_count: Number(stats?.turn_hour_count ?? 0),
    turn_day_count: Number(stats?.turn_day_count ?? 0),
  };
}

async function applyLeadUpdate(
  supabase: SupabaseClient,
  lead: LeadRow,
  suggestion: AiSuggestion,
  stage: Stage,
  needsHuman: boolean,
  humanReason: string,
  sent = false,
): Promise<void> {
  const update: Record<string, unknown> = {
    stage,
    conversation_summary: suggestion.summary ?? lead.conversation_summary,
    treatment_interest: suggestion.treatment_interest ?? lead.treatment_interest,
  };

  if (needsHuman) {
    update.needs_human = true;
    update.automation_status = "HUMAN_REQUIRED";
    update.human_reason = humanReason;
  }

  if (sent) update.last_outbound_at = new Date().toISOString();

  await supabase.from("leads").update(update).eq("id", lead.id);
}

async function markNeedsHuman(supabase: SupabaseClient, leadId: string, reason: string): Promise<void> {
  await supabase
    .from("leads")
    .update({ needs_human: true, automation_status: "HUMAN_REQUIRED", human_reason: reason })
    .eq("id", leadId);
}

async function markUnknownSend(supabase: SupabaseClient, leadId: string): Promise<void> {
  // Envio incerto nunca é reenviado automaticamente: quem decide é uma
  // pessoa, olhando o WhatsApp.
  await markNeedsHuman(supabase, leadId, "envio sem confirmação da Evolution — conferir no WhatsApp");
}

async function finish(
  supabase: SupabaseClient,
  workerId: string,
  turn: ClaimedTurn,
  batchIds: string[],
  outcome: TurnOutcome,
  markProcessed: boolean,
): Promise<void> {
  await closeTurn(supabase, { jobId: turn.jobId, workerId, outcome, batchIds, markProcessed });
}

async function recordDecision(supabase: SupabaseClient, input: DecisionInput): Promise<void> {
  const { error } = await supabase.from("automation_decisions").insert({
    lead_id: input.leadId,
    turn_id: input.turnId,
    batch_message_ids: input.batchIds,
    input_revision: input.inputRevision,
    message_id: input.batchIds[input.batchIds.length - 1] ?? null,
    intent: input.intent ?? null,
    risk: input.risk ?? null,
    confidence: input.confidence ?? null,
    action: input.action,
    stage_before: input.stageBefore,
    stage_after: input.stageAfter,
    reason: input.reason,
    reply_sent: input.replySent,
    bubbles_sent: input.bubblesSent,
    outcome: input.outcome,
    ai_raw: input.aiRaw ?? null,
  });

  // Auditoria não pode derrubar o atendimento, mas silêncio aqui seria pior.
  if (error) log("decisao_nao_registrada", { erro: error.message, leadId: input.leadId });
}
