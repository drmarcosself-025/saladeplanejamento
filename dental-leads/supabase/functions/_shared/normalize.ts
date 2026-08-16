// Normalização do evento da Evolution API / Baileys.
//
// Este é o único lugar do sistema que conhece o formato do WhatsApp. Tudo que
// passa daqui para frente é um objeto previsível. Regras que valem ouro (e que
// já custaram bug em produção no CRM antigo):
//
//   * um código @lid NUNCA vira telefone. Se o número real não puder ser
//     resolvido com segurança, phone = null e o identificador original é
//     preservado em whatsappId;
//   * mensagens vêm "embrulhadas" (ephemeral, viewOnce, documentWithCaption).
//     Sem desembrulhar, a mensagem vira "tipo desconhecido" e some;
//   * grupo, status, broadcast, newsletter, reação e mensagem de protocolo
//     nunca são lead — são descartados aqui, antes de qualquer custo.

export type MessageType =
  | "TEXT"
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "DOCUMENT"
  | "STICKER"
  | "LOCATION"
  | "CONTACT"
  | "OTHER";

export type EventKind = "INBOUND" | "OUTBOUND" | "IGNORE";

export interface NormalizedEvent {
  kind: EventKind;
  ignoreReason?: string;
  /** Identidade estável do lead: o JID normalizado (nunca o telefone). */
  whatsappId: string;
  /** Só preenchido quando o número real é conhecido com segurança. */
  phone: string | null;
  isLid: boolean;
  name: string | null;
  providerMessageId: string;
  messageType: MessageType;
  text: string;
  /**
   * Relógio do WhatsApp. Pode vir adiantado, atrasado ou fora de ordem — serve
   * para exibir e para desempate secundário, nunca para ordenar o batch.
   * Quem manda na cronologia é o received_at gravado pelo banco.
   */
  occurredAt: string;
  /** URLs preservadas como o lead enviou (item 31: a IA não abre link). */
  links: string[];
  /** Mensagem citada, quando o lead responde uma bolha específica. */
  replyToProviderId: string | null;
  meta: Record<string, unknown>;
}

/** URLs recebidas são preservadas inteiras — o painel as mostra clicáveis. */
export function extractLinks(text: string): string[] {
  const matches = (text ?? "").match(/https?:\/\/[^\s<>"']+|(?:^|\s)www\.[^\s<>"']+/gi);
  if (!matches) return [];
  return [...new Set(matches.map((url) => url.trim()))];
}

/**
 * Hash do conteúdo, usado para (a) reconhecer o eco fromMe da nossa própria
 * bolha e (b) impedir que um worker zumbi reenvie a mesma mensagem.
 */
export async function contentHash(text: string): Promise<string> {
  const normalized = (text ?? "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MEDIA_TYPES: MessageType[] = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER"];

export function isMedia(type: MessageType): boolean {
  return MEDIA_TYPES.includes(type);
}

/** Wrappers do Baileys: a mensagem de verdade fica um ou mais níveis abaixo. */
export function unwrapMessage(
  message: Record<string, any> | null | undefined,
  depth = 0,
  wrappers: string[] = [],
): { message: Record<string, any> | null; wrappers: string[] } {
  if (!message || depth > 6) return { message: message ?? null, wrappers };

  const candidates: Array<[string, any]> = [
    ["ephemeralMessage", message.ephemeralMessage?.message],
    ["viewOnceMessage", message.viewOnceMessage?.message],
    ["viewOnceMessageV2", message.viewOnceMessageV2?.message],
    ["viewOnceMessageV2Extension", message.viewOnceMessageV2Extension?.message],
    ["documentWithCaptionMessage", message.documentWithCaptionMessage?.message],
    ["editedMessage", message.editedMessage?.message],
    ["protocolMessage.editedMessage", message.protocolMessage?.editedMessage],
  ];

  for (const [name, inner] of candidates) {
    if (inner) return unwrapMessage(inner, depth + 1, [...wrappers, name]);
  }
  return { message, wrappers };
}

export function detectType(message: Record<string, any> | null): MessageType | "SYSTEM" {
  if (!message) return "OTHER";
  if (message.reactionMessage) return "SYSTEM";
  if (message.protocolMessage || message.senderKeyDistributionMessage) return "SYSTEM";
  if (message.conversation || message.extendedTextMessage || typeof message.text === "string") return "TEXT";
  if (message.buttonsResponseMessage || message.listResponseMessage || message.templateButtonReplyMessage) return "TEXT";
  if (message.imageMessage) return "IMAGE";
  if (message.videoMessage) return "VIDEO";
  if (message.audioMessage || message.pttMessage) return "AUDIO";
  if (message.documentMessage) return "DOCUMENT";
  if (message.stickerMessage) return "STICKER";
  if (message.locationMessage || message.liveLocationMessage) return "LOCATION";
  if (message.contactMessage || message.contactsArrayMessage) return "CONTACT";
  return "OTHER";
}

export function extractText(message: Record<string, any> | null): string {
  if (!message) return "";
  const value = message.conversation ??
    message.extendedTextMessage?.text ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    message.listResponseMessage?.singleSelectReply?.selectedRowId ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    (typeof message.text === "string" ? message.text : "") ??
    "";
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Um telefone real do WhatsApp tem só dígitos e comprimento plausível.
 * Códigos LID são longos e não seguem essa regra — daí a checagem existir.
 */
export function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 && digits === candidate;
}

function jidUser(jid: string): string {
  return (jid || "").split("@")[0].split(":")[0];
}

interface Identity {
  whatsappId: string;
  phone: string | null;
  isLid: boolean;
}

/**
 * Resolve a identidade do contato. A ordem importa:
 *   1. JID normal (@s.whatsapp.net / @c.us) → telefone confiável;
 *   2. JID oculto (@lid) com número real informado pelo WhatsApp
 *      (remoteJidAlt / senderPn) → usa o JID real, assim a conversa não
 *      duplica;
 *   3. JID oculto sem número real → mantém o LID como identidade e
 *      phone = null. Nunca inventar, nunca salvar LID como telefone.
 */
export function resolveIdentity(key: Record<string, any>): Identity {
  const remoteJid: string = key?.remoteJid ?? "";
  const alternatives: string[] = [key?.remoteJidAlt, key?.senderPn, key?.participantPn]
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  if (remoteJid && !remoteJid.endsWith("@lid")) {
    const user = jidUser(remoteJid);
    return {
      whatsappId: remoteJid,
      phone: looksLikePhone(user) ? user : null,
      isLid: false,
    };
  }

  for (const alt of alternatives) {
    const user = jidUser(alt);
    if (looksLikePhone(user) && !alt.endsWith("@lid")) {
      return { whatsappId: `${user}@s.whatsapp.net`, phone: user, isLid: false };
    }
  }

  return { whatsappId: remoteJid, phone: null, isLid: true };
}

function toIsoTimestamp(raw: unknown): string {
  const seconds = typeof raw === "object" && raw !== null
    ? Number((raw as Record<string, unknown>).low ?? NaN)
    : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  return new Date(ms).toISOString();
}

/**
 * Id determinístico para o caso raro de a Evolution entregar um evento sem
 * key.id. Sem um id estável a idempotência morre e uma reentrega vira
 * resposta duplicada.
 */
function syntheticId(whatsappId: string, occurredAt: string, text: string): string {
  let hash = 0;
  const source = `${whatsappId}|${occurredAt}|${text}`;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return `synthetic:${whatsappId}:${occurredAt}:${(hash >>> 0).toString(36)}`;
}

function ignored(reason: string): NormalizedEvent {
  return {
    kind: "IGNORE",
    ignoreReason: reason,
    whatsappId: "",
    phone: null,
    isLid: false,
    name: null,
    providerMessageId: "",
    messageType: "OTHER",
    text: "",
    occurredAt: new Date().toISOString(),
    links: [],
    replyToProviderId: null,
    meta: {},
  };
}

function normalizeItem(item: Record<string, any>): NormalizedEvent {
  const key = item?.key ?? {};
  const remoteJid: string = key.remoteJid ?? "";

  if (!remoteJid) return ignored("sem_remote_jid");
  if (remoteJid.endsWith("@g.us")) return ignored("grupo");
  if (remoteJid === "status@broadcast") return ignored("status");
  if (remoteJid.endsWith("@broadcast")) return ignored("broadcast");
  if (remoteJid.endsWith("@newsletter")) return ignored("newsletter");

  const { message, wrappers } = unwrapMessage(item?.message);
  const detected = detectType(message);
  if (detected === "SYSTEM") return ignored("reacao_ou_protocolo");

  const messageType = detected as MessageType;
  const text = extractText(message);
  if (messageType === "TEXT" && !text) return ignored("texto_vazio");

  const identity = resolveIdentity(key);
  if (!identity.whatsappId) return ignored("sem_identidade");

  const occurredAt = toIsoTimestamp(item?.messageTimestamp);
  const providerMessageId: string = typeof key.id === "string" && key.id
    ? key.id
    : syntheticId(identity.whatsappId, occurredAt, text);

  return {
    kind: key.fromMe === true ? "OUTBOUND" : "INBOUND",
    whatsappId: identity.whatsappId,
    phone: identity.phone,
    isLid: identity.isLid,
    name: typeof item?.pushName === "string" && item.pushName.trim() ? item.pushName.trim() : null,
    providerMessageId,
    messageType,
    text,
    occurredAt,
    links: extractLinks(text),
    replyToProviderId: message?.extendedTextMessage?.contextInfo?.stanzaId ??
      message?.imageMessage?.contextInfo?.stanzaId ??
      message?.videoMessage?.contextInfo?.stanzaId ??
      null,
    meta: {
      remoteJid,
      remoteJidAlt: key.remoteJidAlt ?? null,
      senderPn: key.senderPn ?? null,
      participant: key.participant ?? null,
      wrappers,
      pushName: item?.pushName ?? null,
      source: item?.source ?? null,
    },
  };
}

/**
 * Ponto de entrada. Recebe o corpo cru do webhook e devolve zero ou mais
 * eventos normalizados (a Evolution pode mandar `data` como objeto ou array).
 */
export function normalizeWhatsAppEvent(payload: Record<string, any>): NormalizedEvent[] {
  const event = String(payload?.event ?? payload?.Event ?? "").toLowerCase().replace(/_/g, ".");
  if (event !== "messages.upsert") return [];

  const raw = payload?.data;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items.filter(Boolean).map((item) => normalizeItem(item));
}
