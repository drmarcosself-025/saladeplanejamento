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
  | "FAILED"
  /** Lease vencido, mas já existia um turno mais novo para o mesmo lead.
   *  Não é erro — nunca deve disparar alerta de falha. */
  | "SUPERSEDED"
  /** O worker devolveu o turno por orçamento de parede (WORKER_WALL_BUDGET_MS)
   *  antes de qualquer envio. Também não é erro. */
  | "YIELDED";

/**
 * Motivos de invalidação de assert_turn_valid / reserve_outbound_bubble,
 * centralizados aqui (item 6 da revisão de F2). O SQL devolve texto livre
 * por natureza (é mais barato que manter um enum de Postgres para códigos
 * só de diagnóstico), mas o lado TypeScript trata como união fechada: um
 * motivo fora desta lista é tratado como desconhecido e logado, nunca
 * assumido como seguro.
 */
export type TurnInvalidReason =
  | "lease_perdido"
  /** turn_id não bate com o turn_id atual do job — o fencing token da vez. */
  | "stale_turn_token"
  | "lead_inexistente"
  | "human_takeover"
  | "lead_aguarda_humano"
  | "stale_revision_mismatch"
  | "stale_nova_mensagem"
  | "wall_budget_exceeded"
  | "duplicado"
  /** advance_bubble_to_sending recusou porque a linha não é desta reserva
   *  exata (id/job/worker/turn_id não batem, ou já saiu de PENDING). */
  | "bolha_nao_pertence_a_este_worker"
  | "ok"
  | `automacao_inativa:${string}`
  | `checagem_indisponivel:${string}`
  | "desconhecido";

const KNOWN_REASON_PREFIXES = ["automacao_inativa:", "checagem_indisponivel:"];
const KNOWN_REASONS = new Set<string>([
  "lease_perdido", "stale_turn_token", "lead_inexistente", "human_takeover",
  "lead_aguarda_humano", "stale_revision_mismatch", "stale_nova_mensagem",
  "wall_budget_exceeded", "duplicado", "bolha_nao_pertence_a_este_worker", "ok",
]);

/** Nunca confia cegamente num texto vindo do banco: valida contra a união conhecida. */
export function parseReason(raw: string | undefined | null): TurnInvalidReason {
  const value = raw ?? "desconhecido";
  if (KNOWN_REASONS.has(value)) return value as TurnInvalidReason;
  if (KNOWN_REASON_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return value as TurnInvalidReason;
  }
  return "desconhecido";
}

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

export interface Batch {
  messages: BatchMessage[];
  /**
   * Contador da conversa no exato momento em que este batch foi lido — na
   * MESMA consulta que leu as mensagens, então os dois são sempre
   * consistentes entre si (nunca uma mensagem "no batch mas com revisão
   * velha"). É isto que o turno carrega como input_revision.
   */
  revision: number;
}

export interface ValidityResult {
  valid: boolean;
  reason: TurnInvalidReason;
}

export interface ReserveResult {
  reserved: boolean;
  reason: TurnInvalidReason;
  messageId: string | null;
}

export interface AdvanceResult {
  advanced: boolean;
  reason: TurnInvalidReason;
}

/**
 * Orçamento de parede da invocação inteira (todos os turnos claimados juntos
 * num Promise.all, não por turno) — é o tempo de execução da própria Edge
 * Function que importa, não o de uma conversa isolada. Checado antes de
 * chamar a IA, antes de cada delay e antes de cada bolha (item 7).
 */
export interface WallBudget {
  exceeded(): boolean;
  remainingMs(): number;
}

export function createWallBudget(startedAt: number, budgetMs: number): WallBudget {
  const remainingMs = () => Math.max(budgetMs - (Date.now() - startedAt), 0);
  return { exceeded: () => remainingMs() <= 0, remainingMs };
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

/**
 * Mensagens IN ainda elegíveis do lead, em ordem cronológica estável, mais a
 * revisão da conversa lida na mesma consulta (ver comentário em Batch).
 */
export async function fetchBatch(supabase: SupabaseClient, leadId: string): Promise<Batch> {
  const { data, error } = await supabase.rpc("fetch_batch", { p_lead_id: leadId });
  if (error) throw new Error(`fetch_batch: ${error.message}`);
  const rows = (data ?? []) as Array<BatchMessage & { conversation_revision: number }>;
  return {
    messages: rows.map(({ conversation_revision, ...message }) => message),
    revision: Number(rows[0]?.conversation_revision ?? 0),
  };
}

/**
 * Checkpoint de LEITURA — não escreve nada. Usado pós-IA e como filtro barato
 * antes de gastar uma consulta de rate limit. Quem de fato PROTEGE o envio é
 * reserveOutboundBubble: esta função só evita trabalho desperdiçado quando já
 * dá para saber que o turno morreu.
 *
 * Verifica, nesta ordem: posse do lease · lead existe · human takeover ·
 * automação elegível para este tipo de envio · needs_human · revisão da
 * conversa (O(1)) · mensagem nova fora do batch (defesa em profundidade).
 */
export async function assertTurnStillValid(
  supabase: SupabaseClient,
  input: {
    jobId: number;
    workerId: string;
    /** Token de fencing: o turn_id da concessão de lease que gerou esta chamada. */
    turnId: string;
    leadId: string;
    batchIds: string[];
    inputRevision: number;
    purpose: SendPurpose;
  },
): Promise<ValidityResult> {
  const { data, error } = await supabase.rpc("assert_turn_valid", {
    p_job_id: input.jobId,
    p_worker_id: input.workerId,
    p_turn_id: input.turnId,
    p_lead_id: input.leadId,
    p_batch_ids: input.batchIds,
    p_input_revision: input.inputRevision,
    p_purpose: input.purpose,
  });

  if (error) {
    // Sem confirmação, não se envia. O silêncio é recuperável; a mensagem
    // errada não é.
    log("assert_turn_valid_falhou", { jobId: input.jobId, erro: error.message });
    return { valid: false, reason: parseReason(`checagem_indisponivel:${error.message}`) };
  }

  const result = data as { valid?: boolean; reason?: string } | null;
  const reason = parseReason(result?.reason);
  if (reason === "desconhecido" && result?.reason) {
    log("assert_turn_valid_motivo_nao_reconhecido", { jobId: input.jobId, motivoBruto: result.reason });
  }
  return { valid: result?.valid === true, reason };
}

/**
 * O portão atômico de verdade: checa posse do lease + revisão + takeover +
 * duplicidade E grava a bolha, tudo numa única transação no banco (a linha do
 * job fica travada por FOR UPDATE durante a função inteira). Fecha a janela
 * que assertTurnStillValid sozinho não fecha — entre "confirmei que posso" e
 * "gravei", não existe mais um intervalo em que outro worker possa assumir.
 */
export async function reserveOutboundBubble(
  supabase: SupabaseClient,
  input: {
    jobId: number;
    workerId: string;
    leadId: string;
    inputRevision: number;
    batchIds: string[];
    purpose: SendPurpose;
    turnId: string;
    sequence: number;
    text: string;
    contentHash: string;
  },
): Promise<ReserveResult> {
  const { data, error } = await supabase.rpc("reserve_outbound_bubble", {
    p_job_id: input.jobId,
    p_worker_id: input.workerId,
    p_lead_id: input.leadId,
    p_input_revision: input.inputRevision,
    p_batch_ids: input.batchIds,
    p_purpose: input.purpose,
    p_turn_id: input.turnId,
    p_sequence: input.sequence,
    p_text: input.text,
    p_content_hash: input.contentHash,
    p_dedupe_seconds: config.turn.outboxDedupeSeconds,
  });

  if (error) {
    log("reserve_outbound_bubble_falhou", { jobId: input.jobId, erro: error.message });
    return { reserved: false, reason: parseReason(`checagem_indisponivel:${error.message}`), messageId: null };
  }

  const result = data as { reserved?: boolean; reason?: string; message_id?: string } | null;
  const reason = parseReason(result?.reason);
  if (reason === "desconhecido" && result?.reason) {
    log("reserve_outbound_bubble_motivo_nao_reconhecido", { jobId: input.jobId, motivoBruto: result.reason });
  }
  return {
    reserved: result?.reserved === true,
    reason,
    messageId: result?.message_id ?? null,
  };
}

/**
 * O portão atômico imediatamente antes do POST. Revalida TUDO de novo (lease,
 * fencing por turn_id, takeover, automação, revisão, conjunto de mensagens) e,
 * se ainda válido, transiciona PENDING → SENDING na mesma transação. Se
 * inválido, cancela a bolha ali mesmo (PENDING → CANCELLED) — nunca deixa a
 * linha solta em PENDING para alguém tentar de novo.
 *
 * "advanced: true" é a única condição em que é seguro chamar a Evolution.
 */
export async function advanceBubbleToSending(
  supabase: SupabaseClient,
  input: {
    messageId: string;
    jobId: number;
    workerId: string;
    turnId: string;
    leadId: string;
    inputRevision: number;
    batchIds: string[];
    purpose: SendPurpose;
  },
): Promise<AdvanceResult> {
  const { data, error } = await supabase.rpc("advance_bubble_to_sending", {
    p_message_id: input.messageId,
    p_job_id: input.jobId,
    p_worker_id: input.workerId,
    p_turn_id: input.turnId,
    p_lead_id: input.leadId,
    p_input_revision: input.inputRevision,
    p_batch_ids: input.batchIds,
    p_purpose: input.purpose,
  });

  if (error) {
    log("advance_bubble_to_sending_falhou", { messageId: input.messageId, erro: error.message });
    return { advanced: false, reason: parseReason(`checagem_indisponivel:${error.message}`) };
  }

  const result = data as { advanced?: boolean; reason?: string } | null;
  const reason = parseReason(result?.reason);
  if (reason === "desconhecido" && result?.reason) {
    log("advance_bubble_motivo_nao_reconhecido", { messageId: input.messageId, motivoBruto: result.reason });
  }
  return { advanced: result?.advanced === true, reason };
}

/**
 * O worker devolve o turno por orçamento de parede — não é falha, não gasta
 * tentativa, não mexe em needs_human. Só quem tem o lease consegue ceder.
 * Só deve ser chamado ANTES de qualquer bolha ter sido SENT (ver item 7):
 * depois da primeira confirmada, o turno tem que terminar (COMPLETED ou
 * PARTIAL_STALE), nunca ser devolvido para recomeçar do zero.
 */
export async function yieldTurn(
  supabase: SupabaseClient,
  jobId: number,
  workerId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("yield_turn", { p_job_id: jobId, p_worker_id: workerId });
  if (error) {
    log("yield_turn_falhou", { jobId, erro: error.message });
    return false;
  }
  return data === true;
}

/**
 * Cancela uma bolha já reservada (PENDING) sem passar pela revalidação
 * completa — usado quando o CHAMADOR já decidiu parar por outro motivo (ex.:
 * orçamento de parede estourou logo após reservar, antes de tentar avançar
 * para SENDING). Nunca chama a Evolution. Idempotente: a segunda chamada não
 * encontra mais PENDING e devolve false sem erro. Exige job + worker +
 * turn_id batendo — não é só "quem tem o worker_id".
 */
export async function cancelReservedBubble(
  supabase: SupabaseClient,
  input: { messageId: string; jobId: number; workerId: string; turnId: string; reason: TurnInvalidReason },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("cancel_reserved_bubble", {
    p_message_id: input.messageId,
    p_job_id: input.jobId,
    p_worker_id: input.workerId,
    p_turn_id: input.turnId,
    p_reason: input.reason,
  });
  if (error) {
    log("cancel_reserved_bubble_falhou", { messageId: input.messageId, erro: error.message });
    return false;
  }
  return data === true;
}

export async function reconcileStuckSendingBubbles(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("reconcile_stuck_sending_bubbles");
  if (error) {
    log("reconcile_stuck_sending_falhou", { erro: error.message });
    return 0;
  }
  return Number(data ?? 0);
}

/** Traduz o motivo da invalidação no desfecho que vai para a auditoria. */
export function outcomeForInvalidTurn(reason: TurnInvalidReason, bubblesSent: number): TurnOutcome {
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
