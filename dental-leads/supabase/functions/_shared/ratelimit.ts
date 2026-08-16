// canSendMessage() — o único portão de saída do sistema.
//
// A IA nunca decide quando pode enviar. Todo envio passa por aqui, e todo
// limite vem de env (config.ts). Nenhum número mágico espalhado pelo código.

import { config } from "./config.ts";
import { normalizeForMatch } from "./policy.ts";

export interface SendStats {
  last_out_at: string | null;
  last_out_text: string | null;
  hour_count: number;
  day_count: number;
}

export interface CanSendInput {
  stats: SendStats;
  automationStatus: string;
  needsHuman: boolean;
  /** Mensagem já processada antes (retry/reentrega) — não responder de novo. */
  alreadyProcessed: boolean;
  replyText: string;
  /**
   * AI_REPLY = texto gerado pela IA (exige automação plenamente ativa).
   * HANDOFF  = frase neutra pré-autorizada de "a equipe vai te responder".
   *            Continua valendo para um lead que acabou de virar caso humano,
   *            porque é exatamente a mensagem certa nessa situação — e a
   *            regra anti-duplicidade impede que ela se repita.
   */
  purpose: "AI_REPLY" | "HANDOFF";
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

  if (input.alreadyProcessed) {
    return { allowed: false, reason: "mensagem_ja_processada" };
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

  if (input.stats.last_out_at) {
    const elapsedSeconds = (Date.now() - new Date(input.stats.last_out_at).getTime()) / 1000;
    if (elapsedSeconds < config.rateLimit.minIntervalSeconds) {
      return {
        allowed: false,
        reason: `intervalo_minimo:${Math.round(elapsedSeconds)}s<${config.rateLimit.minIntervalSeconds}s`,
      };
    }
  }

  if (input.stats.hour_count >= config.rateLimit.hourly) {
    return { allowed: false, reason: `limite_hora:${input.stats.hour_count}` };
  }

  if (input.stats.day_count >= config.rateLimit.daily) {
    return { allowed: false, reason: `limite_dia:${input.stats.day_count}` };
  }

  return { allowed: true, reason: "ok" };
}
