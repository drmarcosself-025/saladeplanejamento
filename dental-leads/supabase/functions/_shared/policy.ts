// Policy Engine — a camada determinística que decide o que a IA pode fazer.
//
// Roda DUAS vezes por mensagem:
//   1. antes da IA  → decide se vale gastar uma chamada e com qual restrição;
//   2. depois da IA → confere o texto gerado antes de qualquer envio.
//
// A IA sugere. Aqui é onde se decide. Nenhuma resposta sai sem passar pelas
// duas passagens.

import { config } from "./config.ts";
import { isMedia, type MessageType } from "./normalize.ts";

export type PolicyCategory = "GREEN" | "YELLOW" | "RED";

/** Palavras/expressões que exigem humano. Conteúdo clínico, jurídico, urgência. */
const RED_TERMS = [
  // sintoma / urgência
  "dor", "dores", "doi", "doendo", "doer", "latejando",
  "incha", "inchaco", "inchado", "inchada",
  "sangra", "sangrando", "sangramento", "sangue",
  "pus", "abscesso", "infeccao", "infeccionado", "inflamacao", "inflamado", "febre",
  "quebrou", "quebrei", "caiu o dente", "trincou", "fraturou",
  "emergencia", "urgencia", "urgente", "socorro",
  // clínico / diagnóstico
  "canal", "tratamento de canal", "extracao", "extrair", "arrancar o dente",
  "diagnostico", "diagnosticar", "isso e canal", "sera que e carie",
  "raio x", "raiox", "radiografia", "tomografia", "exame", "exames",
  "cirurgia", "pos operatorio", "pos-operatorio", "cicatrizacao", "sutura",
  // medicação
  "medicamento", "remedio", "antibiotico", "analgesico", "anti-inflamatorio",
  "anti inflamatorio", "dipirona", "amoxicilina", "anestesia", "anestesico",
  "alergia", "alergica", "alergico", "contraindicacao", "contra indicacao",
  "gravida", "gestante", "amamentando", "diabetes", "hipertensao", "anticoagulante",
  // conflito / jurídico
  "reclamacao", "reclamar", "processo", "processar", "advogado", "procon",
  "reembolso", "estorno", "devolucao do dinheiro", "me arrependi",
  // pedido explícito de humano
  "falar com humano", "falar com atendente", "falar com uma pessoa",
  "falar com alguem", "quero falar com o dentista", "falar com o doutor",
  "falar com a doutora", "atendente", "quero um humano",
];

/** Assuntos comerciais sensíveis: pode acolher, não pode inventar número. */
const YELLOW_TERMS = [
  "preco", "precos", "valor", "valores", "quanto custa", "quanto fica",
  "quanto sai", "quanto e", "orcamento", "orcamentos",
  "parcela", "parcelas", "parcelar", "parcelam", "parcelado", "parcelamento",
  "desconto", "descontos", "promocao",
  "forma de pagamento", "formas de pagamento", "cartao", "boleto", "pix",
  "financiamento", "convenio", "plano odontologico", "plano de saude",
  "aceita plano", "tabela de precos",
];

/** Padrões que denunciam valor monetário inventado pela IA. */
const MONEY_PATTERNS: RegExp[] = [
  /r\$\s*\d/i,
  /\d[\d.,]*\s*(reais|conto|pila)\b/i,
  /\b\d{1,3}\s*x\s*(de\s*)?\d/i, // "12x de 300"
  /\b\d[\d.,]*\s*(mil)\b/i,
];

/** A IA não é dentista: nada de prescrever, diagnosticar ou garantir resultado. */
const FORBIDDEN_REPLY_PATTERNS: RegExp[] = [
  /\b(receit|prescrev)\w*/i,
  /\b(tome|tomar|use)\s+(um|uma|o|a)?\s*(remedio|antibiotico|analgesico|dipirona|amoxicilina)/i,
  /\bvoce\s+(esta|ta)\s+com\s+(uma\s+)?(infecc|carie|abscesso|pulpite)/i,
  /\bseu\s+caso\s+e\s+de\s+(canal|extracao|cirurgia)/i,
  /\b(garanto|garantido|com certeza vai|prometo)\b/i,
];

/** Comparação sem acento, minúscula e com espaçamento previsível. */
export function normalizeForMatch(text: string): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Fronteira "manual": evita casar "dor" dentro de "dormir"/"adorei".
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

export function matchTerms(text: string, terms: string[]): string[] {
  const normalized = normalizeForMatch(text);
  return terms.filter((term) => containsTerm(normalized, term));
}

export function classifyText(text: string): { category: PolicyCategory; matched: string[] } {
  const red = matchTerms(text, RED_TERMS);
  if (red.length > 0) return { category: "RED", matched: red };
  const yellow = matchTerms(text, YELLOW_TERMS);
  if (yellow.length > 0) return { category: "YELLOW", matched: yellow };
  return { category: "GREEN", matched: [] };
}

export function containsMoney(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return MONEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

// ---------------------------------------------------------------------------
// Passagem 1 — antes da IA
// ---------------------------------------------------------------------------
export interface PrePolicyInput {
  /** Texto de TODAS as mensagens do turno, já concatenado em ordem. */
  text: string;
  /** Tipos das mensagens do turno (uma rajada pode misturar texto e mídia). */
  messageTypes: MessageType[];
  automationStatus: string;
  needsHuman: boolean;
}

export interface PrePolicyResult {
  category: PolicyCategory;
  /** false = nem chega a chamar a IA (economia é regra, não detalhe). */
  allowAi: boolean;
  needsHuman: boolean;
  reason: string;
  matched: string[];
  /** Resposta neutra pré-autorizada (texto fixo, nunca gerado por IA). */
  handoffMessage: string | null;
}

export function evaluatePrePolicy(input: PrePolicyInput): PrePolicyResult {
  const base = { matched: [] as string[], handoffMessage: null as string | null };

  if (input.automationStatus !== "ACTIVE") {
    return {
      ...base,
      category: "RED",
      allowAi: false,
      needsHuman: false,
      reason: `automacao_inativa:${input.automationStatus}`,
    };
  }

  // Figurinha sozinha não é conversa: não vale uma chamada de IA e não pede
  // resposta. O turno fecha em silêncio e o sistema espera a próxima
  // mensagem (item 34).
  if (
    input.messageTypes.length > 0 &&
    input.messageTypes.every((type) => type === "STICKER") &&
    !input.text.trim()
  ) {
    return { ...base, category: "GREEN", allowAi: false, needsHuman: false, reason: "sticker_isolado" };
  }

  // Mídia sempre é humano na V1 (item 14). Sem download, sem transcrição,
  // sem visão computacional. Mesmo assim o lead recebe a resposta neutra
  // pré-autorizada — silêncio total é pior experiência do que "já te
  // respondo".
  // Figurinha não conta como mídia clínica — é enfeite de conversa, como um
  // emoji. Foto, áudio, vídeo, documento, localização e contato, sim.
  const midia = input.messageTypes.find(
    (type) => type !== "STICKER" && (isMedia(type) || type === "LOCATION" || type === "CONTACT"),
  );
  if (midia) {
    return {
      ...base,
      category: "RED",
      allowAi: false,
      needsHuman: true,
      reason: `midia_exige_humano:${midia}`,
      handoffMessage: config.clinic.handoffMessage,
    };
  }

  if (!input.text.trim()) {
    return { ...base, category: "RED", allowAi: false, needsHuman: false, reason: "sem_texto" };
  }

  if (input.needsHuman) {
    return {
      ...base,
      category: "RED",
      allowAi: false,
      needsHuman: true,
      reason: "lead_ja_aguarda_humano",
      handoffMessage: config.clinic.handoffMessage,
    };
  }

  const { category, matched } = classifyText(input.text);

  if (category === "RED") {
    return {
      category,
      allowAi: false,
      needsHuman: true,
      reason: `politica_vermelha:${matched.join(",")}`,
      matched,
      handoffMessage: config.clinic.handoffMessage,
    };
  }

  return { category, allowAi: true, needsHuman: false, reason: `politica_${category.toLowerCase()}`, matched, handoffMessage: null };
}

// ---------------------------------------------------------------------------
// Passagem 2 — depois da IA, sobre o texto que ela produziu
// ---------------------------------------------------------------------------
export interface PostPolicyInput {
  category: PolicyCategory;
  reply: string;
  action: string;
  confidence: number;
  needsHuman: boolean;
}

export interface PostPolicyResult {
  allowSend: boolean;
  needsHuman: boolean;
  reason: string;
}

export function evaluatePostPolicy(input: PostPolicyInput): PostPolicyResult {
  if (input.action === "IGNORE") {
    return { allowSend: false, needsHuman: false, reason: "ia_pediu_ignorar" };
  }

  if (input.action === "HUMAN" || input.needsHuman) {
    return { allowSend: false, needsHuman: true, reason: "ia_pediu_humano" };
  }

  const reply = (input.reply ?? "").trim();
  if (!reply) {
    return { allowSend: false, needsHuman: true, reason: "resposta_vazia" };
  }

  if (reply.length > config.ai.maxReplyChars) {
    return { allowSend: false, needsHuman: true, reason: "resposta_longa_demais" };
  }

  if (input.confidence < config.ai.minConfidence) {
    return {
      allowSend: false,
      needsHuman: true,
      reason: `confianca_baixa:${input.confidence}`,
    };
  }

  // Conteúdo de risco que a IA tentou responder mesmo assim.
  const replyCategory = classifyText(reply);
  if (replyCategory.category === "RED") {
    return {
      allowSend: false,
      needsHuman: true,
      reason: `resposta_com_termo_vermelho:${replyCategory.matched.join(",")}`,
    };
  }

  if (FORBIDDEN_REPLY_PATTERNS.some((pattern) => pattern.test(normalizeForMatch(reply)))) {
    return { allowSend: false, needsHuman: true, reason: "resposta_com_conteudo_proibido" };
  }

  // Preço inventado é o erro mais caro que essa IA poderia cometer.
  // A allowlist de preços autorizados fica para depois (item 11).
  if (containsMoney(reply)) {
    return { allowSend: false, needsHuman: true, reason: "resposta_com_valor_monetario" };
  }

  return { allowSend: true, needsHuman: false, reason: `aprovado_${input.category.toLowerCase()}` };
}
