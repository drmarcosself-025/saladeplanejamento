// Motor de turno: claim com lock por lead, lease com heartbeat, batch
// cronológico e a checagem que autoriza (ou cancela) qualquer envio.
//
// Um turno é "tudo que o lead falou desde a última resposta". O job não é dono
// de uma mensagem: ele é o sinal de que existe um turno para processar. O
// conjunto de mensagens é montado no claim, consultando o que ainda está
// elegível naquele lead.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { config } from "./config.ts";
import { log } from "./http.ts";

export type TurnOutcome =
  | "COMPLETED"
  | "STALE_BEFORE_SEND"
  | "PARTIAL_STALE"
  | "HUMAN_TAKEOVER"
  | "SEND_UNKNOWN"
  | "NO_REPLY"
  | "FAILED";

export type SendPurpose = "AI_REPLY" | "HANDOFF";

export interface ClaimedTurn {
  jobId: number;
  leadId: string;
  attempts: number;
  turnId: string;
}

export interface BatchMessage {
  id: string;
  text: string | null;
  message_type: string;
  provider_timestamp: string | null;
  received_at: string;
  links: string[] | null;
}

export interface ValidityResult {
  valid: boolean;
  reason: string;
}

/** Identifica esta invocação do worker. É a posse do lease. */
export function newWorkerId(): string {
  return `w_${crypto.randomUUID()}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

/**
 * Tempo de resposta humano: nem instantâneo (denuncia robô), nem demorado.
 * Nunca aplicado a caminhos urgentes — handoff clínico e takeover saem sem
 * espera.
 */
export function naturalDelayMs(minMs: number, maxMs: number): number {
  const low = Math.min(minMs, maxMs);
  const high = Math.max(minMs, maxMs);
  return Math.round(low + Math.random() * (high - low));
}

export async function claimTurns(
  supabase: SupabaseClient,
  workerId: string,
): Promise<ClaimedTurn[]> {
  const { data, error } = await supabase.rpc("claim_lead_jobs", {
    p_worker_id: workerId,
    p_limit: config.worker.batchSize,
    p_lease_seconds: config.worker.leaseSeconds,
  });
  if (error) throw new Error(`claim_lead_jobs: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    jobId: Number(row.job_id),
    leadId: String(row.lead_id),
    attempts: Number(row.attempts ?? 0),
    turnId: String(row.turn_id),
  }));
}

/**
 * Heartbeat do lease. Renovado nos pontos longos do turno:
 *   1. logo depois que a IA responde;
 *   2. imediatamente antes da primeira bolha;
 *   3. depois de cada bolha enviada (Fase 2).
 *
 * false = perdemos a posse (outro worker assumiu o lead). Nesse caso o turno
 * é abortado sem enviar nada.
 */
export async function renewLease(
  supabase: SupabaseClient,
  jobId: number,
  workerId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("renew_lease", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_lease_seconds: config.worker.leaseSeconds,
  });
  if (error) {
    log("renew_lease_falhou", { jobId, erro: error.message });
    return false;
  }
  return data === true;
}

/** Mensagens IN ainda elegíveis do lead, em ordem cronológica estável. */
export async function fetchBatch(
  supabase: SupabaseClient,
  leadId: string,
): Promise<BatchMessage[]> {
  const { data, error } = await supabase.rpc("fetch_batch", { p_lead_id: leadId });
  if (error) throw new Error(`fetch_batch: ${error.message}`);
  return (data ?? []) as BatchMessage[];
}

/**
 * A pergunta do item 53, em uma ida ao banco. Chamada pós-IA, antes da
 * primeira bolha e antes de cada bolha seguinte.
 *
 * Verifica, nesta ordem: posse do lease · lead existe · human takeover ·
 * automação elegível para este tipo de envio · needs_human · mensagem nova
 * fora do batch.
 */
export async function assertTurnStillValid(
  supabase: SupabaseClient,
  input: {
    jobId: number;
    workerId: string;
    leadId: string;
    batchIds: string[];
    purpose: SendPurpose;
  },
): Promise<ValidityResult> {
  const { data, error } = await supabase.rpc("assert_turn_valid", {
    p_job_id: input.jobId,
    p_worker_id: input.workerId,
    p_lead_id: input.leadId,
    p_batch_ids: input.batchIds,
    p_purpose: input.purpose,
  });

  if (error) {
    // Sem confirmação, não se envia. O silêncio é recuperável; a mensagem
    // errada não é.
    log("assert_turn_valid_falhou", { jobId: input.jobId, erro: error.message });
    return { valid: false, reason: `checagem_indisponivel:${error.message}` };
  }

  const result = data as ValidityResult | null;
  return { valid: result?.valid === true, reason: result?.reason ?? "desconhecido" };
}

/** Traduz o motivo da invalidação no desfecho que vai para a auditoria. */
export function outcomeForInvalidTurn(reason: string, bubblesSent: number): TurnOutcome {
  if (reason === "human_takeover") return "HUMAN_TAKEOVER";
  if (bubblesSent > 0) return "PARTIAL_STALE";
  return "STALE_BEFORE_SEND";
}

export async function closeTurn(
  supabase: SupabaseClient,
  input: {
    jobId: number;
    workerId: string;
    outcome: TurnOutcome;
    batchIds: string[];
    /**
     * Só marcar o batch como processado quando alguma bolha saiu. Turno
     * abortado antes de qualquer envio devolve as mensagens para o próximo
     * batch — assim o lead recebe UMA resposta coerente, e não duas parciais.
     */
    markProcessed: boolean;
    error?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.rpc("close_turn", {
    p_job_id: input.jobId,
    p_worker_id: input.workerId,
    p_outcome: input.outcome,
    p_batch_ids: input.batchIds,
    p_mark_processed: input.markProcessed,
    p_error: input.error ?? null,
    p_max_attempts: config.worker.maxAttempts,
    p_backoff_base: config.worker.backoffBaseSeconds,
  });
  if (error) log("close_turn_falhou", { jobId: input.jobId, erro: error.message });
}

export async function reclaimExpiredJobs(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("reclaim_expired_jobs");
  if (error) {
    log("reclaim_falhou", { erro: error.message });
    return 0;
  }
  return Number(data ?? 0);
}
