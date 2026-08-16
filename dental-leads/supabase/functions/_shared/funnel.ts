// Regras de funil. A IA sugere uma etapa; quem decide é isto aqui.
//
// Duas regras que não se negociam (item 15):
//   * CONVERTED e LOST são sempre manuais — a IA nunca coloca um lead lá;
//   * o funil não anda para trás sozinho.

export type Stage = "NEW" | "CONVERSATION" | "INTEREST" | "SCHEDULING" | "CONVERTED" | "LOST";

/** Etapas que a automação pode alcançar, em ordem. */
const AUTOMATABLE: Stage[] = ["NEW", "CONVERSATION", "INTEREST", "SCHEDULING"];

/** Etapas finais: só mudam por decisão de uma pessoa, no painel. */
const TERMINAL: Stage[] = ["CONVERTED", "LOST"];

export function isTerminal(stage: Stage): boolean {
  return TERMINAL.includes(stage);
}

export interface StageDecision {
  stage: Stage;
  changed: boolean;
  reason: string;
}

/**
 * @param current   etapa atual do lead
 * @param suggested etapa sugerida pela IA (pode vir inválida ou ausente)
 * @param replied   se a automação de fato respondeu nesta rodada
 */
export function resolveStage(current: Stage, suggested: unknown, replied: boolean): StageDecision {
  if (isTerminal(current)) {
    return { stage: current, changed: false, reason: "etapa_final_so_muda_manualmente" };
  }

  // Responder a um lead que ainda está em NEW já significa que a conversa
  // começou — isso é determinístico, não depende da IA acertar.
  const floor: Stage = replied && current === "NEW" ? "CONVERSATION" : current;

  const candidate = typeof suggested === "string" ? (suggested.toUpperCase() as Stage) : null;

  if (!candidate || !AUTOMATABLE.includes(candidate)) {
    return {
      stage: floor,
      changed: floor !== current,
      reason: candidate ? `sugestao_invalida:${candidate}` : "sem_sugestao",
    };
  }

  const currentIndex = AUTOMATABLE.indexOf(floor);
  const candidateIndex = AUTOMATABLE.indexOf(candidate);

  if (candidateIndex <= currentIndex) {
    return { stage: floor, changed: floor !== current, reason: "sugestao_nao_avanca" };
  }

  // Um degrau por mensagem: evita pular de NEW direto para SCHEDULING por
  // entusiasmo do modelo.
  const nextIndex = Math.min(candidateIndex, currentIndex + 1);
  const next = AUTOMATABLE[nextIndex];
  return { stage: next, changed: next !== current, reason: `avanco_para_${next}` };
}
