// lead-worker — orquestrador de TURNO.
//
// Um turno é tudo que o lead falou desde a última resposta. O pipeline:
//
//   claim (lock por lead) → batch cronológico → Policy Engine (pré) →
//   [checkpoint: orçamento de parede] → 1 chamada de IA → Policy Engine (pós)
//   → assertTurnStillValid → rate limit → [checkpoint: orçamento] →
//   POR BOLHA: delay natural → [checkpoint: orçamento] → reserva atômica →
//   advance-to-SENDING atômico (revalida tudo de novo) → POST na Evolution →
//   SENT/UNKNOWN/FAILED → funil + resumo (só se completo) → decisão
//   auditável → close_turn
//
// Nada aqui confia na IA, e nada sai sem revalidação imediatamente antes do
// POST: entre pensar e falar, a conversa pode ter mudado.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { assertConfig, config, configWarnings } from "../_shared/config.ts";
import { json, log, secretMatches } from "../_shared/http.ts";
import { analyzeMessage, type AiSuggestion } from "../_shared/ai.ts";
import { evaluatePostPolicy, evaluatePrePolicy } from "../_shared/policy.ts";
import { canSendMessage, type TurnStats } from "../_shared/ratelimit.ts";
import { resolveStage, type Stage } from "../_shared/funnel.ts";
import { sendText } from "../_shared/evolution.ts";
import { contentHash, type MessageType } from "../_shared/normalize.ts";
import {
  advanceBubbleToSending,
  assertTurnStillValid,
  type BatchMessage,
  type ClaimedTurn,
  claimTurns,
  closeTurn,
  createWallBudget,
  fetchBatch,
  finalizeBubbleSend,
  naturalDelayMs,
  newWorkerId,
  outcomeForInvalidTurn,
  parseReason,
  reclaimExpiredJobs,
  reconcileStuckSendingBubbles,
  renewLease,
  reserveOutboundBubble,
  type SendPurpose,
  shouldYieldOnBudgetExceeded,
  sleep,
  type TurnOutcome,
  type WallBudget,
  yieldTurn,
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
  bubblesPlanned: number;
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
  for (const warning of configWarnings()) log("config_perigosa", { aviso: warning });

  if (!secretMatches(req.headers.get("x-worker-secret"), config.worker.secret)) {
    return json({ error: "nao_autorizado" }, 401);
  }

  const startedAt = Date.now();
  // Orçamento de parede da INVOCAÇÃO inteira (todos os turnos claimados
  // juntos), não de um turno isolado — é o tempo de execução da Edge
  // Function que precisa caber no limite da plataforma.
  const wallBudget = createWallBudget(startedAt, config.worker.wallBudgetMs);
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

  // Reconciliação antes de qualquer claim novo: bolha travada em SENDING
  // (worker morreu entre o POST aceito e a gravação do resultado) vira
  // UNKNOWN, nunca PENDING. Job com lease vencido volta pra fila, ou é
  // encerrado como SUPERSEDED se já existe turno mais novo do mesmo lead.
  await reconcileStuckSendingBubbles(supabase);
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
    turns.map((turn) => runTurnSafely(supabase, workerId, turn, wallBudget)),
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
  wallBudget: WallBudget,
): Promise<TurnResult> {
  try {
    return await runTurn(supabase, workerId, turn, wallBudget);
  } catch (error) {
    // Erro transitório (rede, IA fora do ar, 429 da Evolution): volta para a
    // fila com backoff. O batch permanece não processado, então o próximo
    // turno reúne tudo de novo.
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
  wallBudget: WallBudget,
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
  // termo vermelho, automação pausada). A frase neutra, quando existe,
  // passa pelo MESMO motor de sequência de bolhas — não é um caminho
  // paralelo com menos proteção.
  // -------------------------------------------------------------------
  if (!pre.allowAi) {
    const messages = pre.handoffMessage ? [pre.handoffMessage] : [];
    const sequence = messages.length > 0
      ? await sendBubbleSequence(supabase, {
        lead,
        jobId: turn.jobId,
        turnId: turn.turnId,
        workerId,
        batchIds,
        revision,
        purpose: "HANDOFF",
        messages,
        // Handoff clínico não espera: quem está com dor não pode ficar
        // olhando pro silêncio por segundos enquanto o sistema "pensa".
        firstDelayMs: 0,
        wallBudget,
      })
      : null;

    if (sequence?.kind === "yielded") {
      // Sem enviar nada ainda: devolve o turno, nada de tentativa gasta.
      return { outcome: "YIELDED", replied: false };
    }

    const bubblesSent = sequence?.kind === "closed" ? sequence.bubblesSent : 0;
    const markProcessed = sequence?.kind === "closed" ? sequence.markProcessed : true;
    const outcome: TurnOutcome = sequence?.kind === "closed" ? sequence.outcome : "NO_REPLY";

    if (pre.needsHuman) {
      await supabase
        .from("leads")
        .update({ needs_human: true, automation_status: "HUMAN_REQUIRED", human_reason: pre.reason })
        .eq("id", lead.id);
    } else if (sequence?.kind === "closed" && sequence.needsHuman) {
      await markNeedsHuman(supabase, lead.id, sequence.humanReason ?? "envio incerto");
    }

    await recordDecision(supabase, {
      leadId: lead.id,
      turnId: turn.turnId,
      batchIds,
      inputRevision: revision,
      risk: pre.category === "RED" ? "HIGH" : pre.category === "YELLOW" ? "MEDIUM" : "LOW",
      action: bubblesSent > 0 ? "HUMAN" : pre.needsHuman ? "HUMAN" : "IGNORE",
      stageBefore: lead.stage,
      stageAfter: lead.stage,
      reason: sequence?.kind === "closed" ? `${pre.reason} | ${sequence.lastReason}` : pre.reason,
      replySent: bubblesSent > 0,
      bubblesSent,
      bubblesPlanned: messages.length,
      outcome,
    });

    // Mesmo sem resposta, o batch foi decidido: marcá-lo como processado
    // evita reprocessar a mesma figurinha/mídia para sempre.
    await finish(supabase, workerId, turn, batchIds, outcome, markProcessed);
    return { outcome, replied: bubblesSent > 0 };
  }

  // Checkpoint de orçamento — antes de gastar a chamada de IA (item 7).
  if (wallBudget.exceeded()) {
    const yielded = await yieldTurn(supabase, turn.jobId, workerId);
    log("yield_pre_ia", { jobId: turn.jobId, yielded });
    return { outcome: "YIELDED", replied: false };
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
      bubblesPlanned: 0,
      outcome: "NO_REPLY",
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, "NO_REPLY", true);
    return { outcome: "NO_REPLY", replied: false };
  }

  const suggestion: AiSuggestion = analysis.value;

  const post = evaluatePostPolicy({
    category: pre.category,
    replyMessages: suggestion.reply_messages,
    action: suggestion.action,
    confidence: suggestion.confidence,
    needsHuman: suggestion.needs_human,
  });

  const purpose: SendPurpose = post.allowSend ? "AI_REPLY" : "HANDOFF";
  const messagesToSend = post.allowSend ? suggestion.reply_messages : [config.clinic.handoffMessage];

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
      bubblesPlanned: 0,
      outcome: "NO_REPLY",
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, "NO_REPLY", true);
    return { outcome: "NO_REPLY", replied: false };
  }

  // --- Checkpoint barato: a resposta recém-gerada ainda vale a pena? ----
  // (Evita reservar e cancelar quando já dá pra saber que o turno morreu.)
  const afterAi = await assertTurnStillValid(supabase, {
    jobId: turn.jobId,
    workerId,
    turnId: turn.turnId,
    leadId: lead.id,
    batchIds,
    inputRevision: revision,
    purpose,
  });

  if (!afterAi.valid) {
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
      bubblesPlanned: messagesToSend.length,
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
    replyText: messagesToSend.join(" "),
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
      bubblesPlanned: messagesToSend.length,
      outcome: "NO_REPLY",
      aiRaw: analysis.raw,
    });
    await finish(supabase, workerId, turn, batchIds, "NO_REPLY", true);
    return { outcome: "NO_REPLY", replied: false };
  }

  // --- A sequência de bolhas propriamente dita --------------------------
  const sequence = await sendBubbleSequence(supabase, {
    lead,
    jobId: turn.jobId,
    turnId: turn.turnId,
    workerId,
    batchIds,
    revision,
    purpose,
    messages: messagesToSend,
    firstDelayMs: purpose === "HANDOFF"
      ? 0
      : naturalDelayMs(config.turn.responseDelayMinMs, config.turn.responseDelayMaxMs),
    wallBudget,
  });

  if (sequence.kind === "yielded") {
    return { outcome: "YIELDED", replied: false };
  }

  const aiReplySent = sequence.bubblesSent > 0 && purpose === "AI_REPLY" && sequence.outcome === "COMPLETED";

  // O funil e o resumo só andam quando o turno COMPLETOU de verdade. Uma
  // sequência parcial (PARTIAL_STALE) não aplica a decisão da IA — ela foi
  // calculada para uma resposta que não terminou de sair; o próximo turno
  // recalcula do histórico real.
  const stageDecision = sequence.outcome === "COMPLETED"
    ? resolveStage(lead.stage, suggestion.stage, aiReplySent)
    : { stage: lead.stage, changed: false, reason: "turno_incompleto_nao_aplica_funil" };

  if (sequence.outcome === "COMPLETED") {
    await applyLeadUpdate(
      supabase,
      lead,
      suggestion,
      stageDecision.stage,
      post.needsHuman || sequence.needsHuman,
      suggestion.human_reason ?? sequence.humanReason ?? post.reason,
      sequence.bubblesSent > 0,
    );
  } else if (sequence.needsHuman) {
    await markNeedsHuman(supabase, lead.id, sequence.humanReason ?? "envio incerto");
  }

  await recordDecision(supabase, {
    leadId: lead.id,
    turnId: turn.turnId,
    batchIds,
    inputRevision: revision,
    intent: suggestion.intent,
    risk: suggestion.risk,
    confidence: suggestion.confidence,
    action: aiReplySent ? "AUTO_REPLY" : (sequence.needsHuman || post.needsHuman) ? "HUMAN" : "IGNORE",
    stageBefore: lead.stage,
    stageAfter: stageDecision.stage,
    reason: `${post.reason} | ${sequence.lastReason} | funil:${stageDecision.reason}`,
    replySent: sequence.bubblesSent > 0,
    bubblesSent: sequence.bubblesSent,
    bubblesPlanned: sequence.bubblesPlanned,
    outcome: sequence.outcome,
    aiRaw: analysis.raw,
  });

  await finish(supabase, workerId, turn, batchIds, sequence.outcome, sequence.markProcessed);
  return { outcome: sequence.outcome, replied: sequence.bubblesSent > 0 };
}

// ---------------------------------------------------------------------------
// O motor de sequência de bolhas.
//
// Por bolha, sempre nesta ordem:
//   1. checkpoint de orçamento de parede (yield se nada saiu ainda, para se
//      já saiu alguma);
//   2. delay natural;
//   3. reserva atômica (PENDING) — lease + revisão + takeover + duplicidade;
//   4. avanço atômico para SENDING — revalida TUDO de novo (é aqui que a
//      corrida "perdi o lease entre reservar e mandar" é fechada: se
//      inválido, a própria função já cancela a bolha, PENDING → CANCELLED);
//   5. só agora o POST na Evolution;
//   6. SENT seguimos; UNKNOWN paramos (nunca reenviamos); FAILED permanente
//      paramos sem gastar tentativa de job; FAILED retryable (429) lança
//      exceção pro job tentar de novo com backoff.
//
// PARTIAL_STALE é o desfecho de qualquer interrupção com bubblesSent > 0:
// as bolhas que já saíram, saíram; as que não chegaram a ser reservadas nem
// existem como linha. Nenhuma atualização semântica (stage/summary/interesse)
// é aplicada pelo chamador quando o outcome não é COMPLETED.
// ---------------------------------------------------------------------------
interface BubbleSequenceInput {
  lead: LeadRow;
  jobId: number;
  turnId: string;
  workerId: string;
  batchIds: string[];
  revision: number;
  purpose: SendPurpose;
  messages: string[];
  firstDelayMs: number;
  wallBudget: WallBudget;
}

type BubbleSequenceResult =
  | { kind: "yielded" }
  | {
    kind: "closed";
    bubblesSent: number;
    bubblesPlanned: number;
    outcome: TurnOutcome;
    markProcessed: boolean;
    needsHuman: boolean;
    humanReason?: string;
    /** Motivo de auditoria. Para reserva/avanço recusados é um TurnInvalidReason
     *  de verdade; para SEND_UNKNOWN/SEND_FAILED é uma descrição própria —
     *  o campo é texto livre no banco, não um enum, então não força um
     *  motivo de stale a descrever um problema de envio. */
    lastReason: string;
  };

async function sendBubbleSequence(
  supabase: SupabaseClient,
  input: BubbleSequenceInput,
): Promise<BubbleSequenceResult> {
  const total = input.messages.length;
  let sent = 0;

  // Estimativa proativa: antes de reservar a 1ª bolha, confere se o
  // orçamento restante comporta a sequência inteira. É melhor devolver o
  // turno limpo agora do que descobrir no meio (depois de já ter mandado
  // bolha 1) que não dava tempo — depois da 1ª SENT não se pode mais ceder
  // (item 7).
  const estimatedMs = input.firstDelayMs +
    Math.max(total - 1, 0) * config.turn.bubbleDelayMaxMs +
    total * config.turn.bubbleSendMarginMs;

  if (input.wallBudget.remainingMs() < estimatedMs) {
    const yielded = await yieldTurn(supabase, input.jobId, input.workerId);
    log("yield_pre_sequencia", { jobId: input.jobId, estimatedMs, yielded });
    return { kind: "yielded" };
  }

  for (let i = 0; i < total; i++) {
    const isFirst = i === 0;
    const delayMs = isFirst
      ? input.firstDelayMs
      : naturalDelayMs(config.turn.bubbleDelayMinMs, config.turn.bubbleDelayMaxMs);

    // Checkpoint de orçamento (item 7): nada enviado ainda → devolve o
    // turno inteiro. Já enviamos alguma coisa → nunca mais se cede (regra
    // testada isoladamente em shouldYieldOnBudgetExceeded); encerra com o
    // que já saiu.
    if (input.wallBudget.exceeded()) {
      if (shouldYieldOnBudgetExceeded(sent)) {
        const yielded = await yieldTurn(supabase, input.jobId, input.workerId);
        log("yield_no_meio_sem_envio", { jobId: input.jobId, yielded });
        return { kind: "yielded" };
      }
      return closeSequence(sent, total, "wall_budget_exceeded");
    }

    if (delayMs > 0) await sleep(delayMs);

    const text = input.messages[i];
    const hash = await contentHash(text);

    const reservation = await reserveOutboundBubble(supabase, {
      jobId: input.jobId,
      workerId: input.workerId,
      leadId: input.lead.id,
      inputRevision: input.revision,
      batchIds: input.batchIds,
      purpose: input.purpose,
      turnId: input.turnId,
      sequence: i + 1,
      text,
      contentHash: hash,
    });

    if (!reservation.reserved) {
      if (reservation.reason === "duplicado") {
        // Já foi confirmada SENT numa tentativa anterior deste mesmo turno
        // (worker retomado após yield/reclaim gerou texto idêntico). Não
        // reenvia — conta como entregue e segue para a próxima bolha.
        log("bolha_ja_enviada_antes", { leadId: input.lead.id, turnId: input.turnId, sequence: i + 1 });
        sent++;
        continue;
      }
      return closeSequence(sent, total, reservation.reason);
    }

    const messageId = reservation.messageId!;

    // O portão atômico: revalida tudo de novo e só transiciona pra SENDING
    // se ainda estiver tudo certo. Se não, a própria função já cancela a
    // bolha (PENDING → CANCELLED) — nunca fica solta pra alguém reenviar.
    const advance = await advanceBubbleToSending(supabase, {
      messageId,
      jobId: input.jobId,
      workerId: input.workerId,
      turnId: input.turnId,
      leadId: input.lead.id,
      inputRevision: input.revision,
      batchIds: input.batchIds,
      purpose: input.purpose,
    });

    if (!advance.advanced) {
      return closeSequence(sent, total, advance.reason);
    }

    const result = await sendText(input.lead.phone ?? input.lead.whatsapp_id, text);

    // A ÚNICA porta de escrita do resultado final — nunca um update
    // irrestrito. Se o reconciler já moveu esta bolha pra UNKNOWN enquanto
    // o POST estava em voo (lease perdido no meio do caminho), a escrita
    // não sobrescreve silenciosamente: "late" avisa que o resultado chegou
    // tarde demais para valer.
    async function finalize(status: "SENT" | "FAILED" | "UNKNOWN") {
      return finalizeBubbleSend(supabase, {
        messageId,
        jobId: input.jobId,
        workerId: input.workerId,
        turnId: input.turnId,
        result: status,
        providerMessageId: result.providerMessageId,
      });
    }

    if (result.status === "SENT") {
      const outcome = await finalize("SENT");
      if (outcome.late) {
        // O sistema já não confia mais nesta bolha (foi reconciliada pra
        // UNKNOWN enquanto o POST original ainda estava em voo). A entrega
        // tardia fica registrada em meta.late_confirmation para auditoria,
        // mas não conta como "enviada" para o desfecho deste turno — quem
        // já foi chamado a olhar continua sendo chamado.
        return closeSequence(sent, total, "late_confirmation_after_reconciliation");
      }
      await supabase
        .from("leads")
        .update({ last_message_at: new Date().toISOString(), last_outbound_at: new Date().toISOString() })
        .eq("id", input.lead.id);
      sent++;
      continue;
    }

    if (result.status === "UNKNOWN") {
      // Nunca sabemos se chegou. Nunca reenviamos. Para a sequência aqui —
      // as bolhas seguintes nem chegam a ser reservadas.
      await finalize("UNKNOWN");
      return {
        kind: "closed",
        bubblesSent: sent,
        bubblesPlanned: total,
        outcome: "SEND_UNKNOWN",
        markProcessed: true,
        needsHuman: true,
        humanReason: "envio sem confirmação da Evolution — conferir no WhatsApp",
        lastReason: "send_unknown",
      };
    }

    if (result.status === "PERMANENT_FAILURE") {
      // Rejeição de verdade (número inválido, sem permissão, payload
      // rejeitado). Retentar por backoff não muda o resultado — vira caso
      // humano na hora, sem gastar tentativa de job.
      await finalize("FAILED");
      return {
        kind: "closed",
        bubblesSent: sent,
        bubblesPlanned: total,
        outcome: "SEND_FAILED",
        markProcessed: true,
        needsHuman: true,
        humanReason: `envio recusado pela Evolution (${result.error ?? "motivo desconhecido"}) — conferir manualmente`,
        lastReason: `send_permanent_failure:${result.error ?? "desconhecido"}`,
      };
    }

    // RETRYABLE_FAILURE (429): a própria Evolution está pedindo para
    // esperar. Isso é exatamente o caso de uso do backoff exponencial que o
    // job já tem — lança e deixa o catch de runTurnSafely cuidar do retry.
    await finalize("FAILED");
    throw new Error(`bolha_retryable:${result.error ?? "429"}`);
  }

  return closeSequence(sent, total, "ok");
}

function closeSequence(sent: number, total: number, reason: string): BubbleSequenceResult {
  const outcome = sent === total ? "COMPLETED" : outcomeForInvalidTurn(parseReason(reason), sent);
  return {
    kind: "closed",
    bubblesSent: sent,
    bubblesPlanned: total,
    outcome,
    // Só marca o batch como processado quando pelo menos uma bolha saiu —
    // turno sem nenhum envio devolve as mensagens inteiras para o próximo.
    markProcessed: sent > 0,
    needsHuman: false,
    lastReason: reason,
  };
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
    bubbles_planned: input.bubblesPlanned,
    outcome: input.outcome,
    ai_raw: input.aiRaw ?? null,
  });

  // Auditoria não pode derrubar o atendimento, mas silêncio aqui seria pior.
  if (error) log("decisao_nao_registrada", { erro: error.message, leadId: input.leadId });
}
