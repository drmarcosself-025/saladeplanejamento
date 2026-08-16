// canSendMessage() — o único portão de saída do sistema.
//
// A IA nunca decide quando pode enviar. Todo envio passa por aqui, e todo
// limite vem de env (config.ts).
//
// Unidade de contagem: TURNO, não mensagem. Uma resposta pode sair em até 3
// bolhas; se o limite contasse mensagens, o intervalo mínimo da bolha 1
// bloquearia a bolha 2 da mesma resposta. O espaçamento entre bolhas é
// interno ao turno (config.turn.bubbleDelay*), não é rate limit.

import { config } from "./config.ts";
import { normalizeForMatch } from "./policy.ts";
import type { SendPurpose } from "./turn.ts";

export interface TurnStats {
  /** Início do último turno em que alguma resposta saiu. */
  last_turn_at: string | null;
  /** Texto da última bolha enviada (anti-loop). */
  last_out_text: string | null;
  turn_hour_count: number;
  turn_day_count: number;
}

export interface CanSendInput {
  stats: TurnStats;
  automationStatus: string;
  needsHuman: boolean;
  replyText: string;
  /**
   * AI_REPLY = texto gerado pela IA (exige automação plenamente ativa).
   * HANDOFF  = frase neutra pré-autorizada de "a equipe vai te responder".
   *            Continua valendo em HUMAN_REQUIRED, porque é exatamente a
   *            mensagem certa nessa situação — e a regra anti-duplicidade
   *            impede que ela se repita.
   */
  purpose: SendPurpose;
}

export interface CanSendResult {
  allowed: boolean;
  reason: string;
}

export function canSendMessage(input: CanSendInput): CanSendResult {
  const statusPermitido = input.purpose === "HANDOFF"
    ? ["ACTIVE", "HUMAN_REQUIRED"]
    : ["ACTIVE"];

  if (!statusPermitido.includes(input.automationStatus)) {
    return { allowed: false, reason: `automacao_inativa:${input.automationStatus}` };
  }

  if (input.purpose === "AI_REPLY" && input.needsHuman) {
    return { allowed: false, reason: "lead_aguarda_humano" };
  }

  const reply = normalizeForMatch(input.replyText);
  if (!reply) {
    return { allowed: false, reason: "resposta_vazia" };
  }

  // Anti-loop: a mesma resposta duas vezes seguidas é sinal de que algo
  // travou, não de conversa.
  if (input.stats.last_out_text && normalizeForMatch(input.stats.last_out_text) === reply) {
    return { allowed: false, reason: "resposta_identica_a_anterior" };
  }

  if (input.stats.last_turn_at) {
    const elapsedSeconds = (Date.now() - new Date(input.stats.last_turn_at).getTime()) / 1000;
    if (elapsedSeconds < config.rateLimit.minIntervalSeconds) {
      return {
        allowed: false,
        reason: `intervalo_minimo:${Math.round(elapsedSeconds)}s<${config.rateLimit.minIntervalSeconds}s`,
      };
    }
  }

  if (input.stats.turn_hour_count >= config.rateLimit.hourly) {
    return { allowed: false, reason: `limite_hora:${input.stats.turn_hour_count}` };
  }

  if (input.stats.turn_day_count >= config.rateLimit.daily) {
    return { allowed: false, reason: `limite_dia:${input.stats.turn_day_count}` };
  }

  return { allowed: true, reason: "ok" };
}
