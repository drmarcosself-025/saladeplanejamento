// deno test --allow-env dental-leads/tests/
//
// A normalização é o ponto de maior risco técnico do projeto: é onde o
// formato do WhatsApp encosta no nosso. Cada caso aqui representa um evento
// real que já quebrou sistema de WhatsApp em produção.

import { assertEquals } from "jsr:@std/assert@1";
import {
  normalizeWhatsAppEvent,
  resolveIdentity,
  unwrapMessage,
} from "../supabase/functions/_shared/normalize.ts";

function upsert(data: unknown) {
  return { event: "messages.upsert", data };
}

Deno.test("texto simples de lead vira evento INBOUND", () => {
  const [event] = normalizeWhatsAppEvent(upsert({
    key: { remoteJid: "5511999998888@s.whatsapp.net", fromMe: false, id: "ABC123" },
    message: { conversation: "Oi, queria saber sobre Invisalign" },
    pushName: "Maria",
    messageTimestamp: 1735689600,
  }));

  assertEquals(event.kind, "INBOUND");
  assertEquals(event.phone, "5511999998888");
  assertEquals(event.isLid, false);
  assertEquals(event.messageType, "TEXT");
  assertEquals(event.text, "Oi, queria saber sobre Invisalign");
  assertEquals(event.name, "Maria");
  assertEquals(event.providerMessageId, "ABC123");
});

Deno.test("LID sem número real nunca vira telefone", () => {
  const identity = resolveIdentity({ remoteJid: "123456789012345678@lid" });
  assertEquals(identity.phone, null);
  assertEquals(identity.isLid, true);
  assertEquals(identity.whatsappId, "123456789012345678@lid");
});

Deno.test("LID com remoteJidAlt usa o número real e não duplica a conversa", () => {
  const identity = resolveIdentity({
    remoteJid: "123456789012345678@lid",
    remoteJidAlt: "5511999998888@s.whatsapp.net",
  });
  assertEquals(identity.phone, "5511999998888");
  assertEquals(identity.isLid, false);
  assertEquals(identity.whatsappId, "5511999998888@s.whatsapp.net");
});

Deno.test("mensagem embrulhada (ephemeral + viewOnce) é desembrulhada", () => {
  const { message, wrappers } = unwrapMessage({
    ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: "oi" } } } },
  });
  assertEquals(message?.conversation, "oi");
  assertEquals(wrappers, ["ephemeralMessage", "viewOnceMessageV2"]);
});

Deno.test("grupo, status e broadcast são descartados", () => {
  const cases = ["120363000000000000@g.us", "status@broadcast", "algo@broadcast"];
  for (const remoteJid of cases) {
    const [event] = normalizeWhatsAppEvent(upsert({
      key: { remoteJid, fromMe: false, id: "X" },
      message: { conversation: "oi" },
    }));
    assertEquals(event.kind, "IGNORE");
  }
});

Deno.test("fromMe vira OUTBOUND (entrada da detecção de takeover)", () => {
  const [event] = normalizeWhatsAppEvent(upsert({
    key: { remoteJid: "5511999998888@s.whatsapp.net", fromMe: true, id: "OUT1" },
    message: { conversation: "Oi! Já te respondo" },
  }));
  assertEquals(event.kind, "OUTBOUND");
});

Deno.test("mídia é reconhecida pelo tipo, mesmo sem legenda", () => {
  const [event] = normalizeWhatsAppEvent(upsert({
    key: { remoteJid: "5511999998888@s.whatsapp.net", fromMe: false, id: "IMG1" },
    message: { imageMessage: { mimetype: "image/jpeg" } },
  }));
  assertEquals(event.messageType, "IMAGE");
  assertEquals(event.kind, "INBOUND");
});

Deno.test("reação e mensagem de protocolo não são conteúdo de lead", () => {
  for (const message of [{ reactionMessage: { text: "👍" } }, { protocolMessage: { type: 0 } }]) {
    const [event] = normalizeWhatsAppEvent(upsert({
      key: { remoteJid: "5511999998888@s.whatsapp.net", fromMe: false, id: "R1" },
      message,
    }));
    assertEquals(event.kind, "IGNORE");
    assertEquals(event.ignoreReason, "reacao_ou_protocolo");
  }
});

Deno.test("evento sem id ganha id determinístico (idempotência não pode cair)", () => {
  const payload = upsert({
    key: { remoteJid: "5511999998888@s.whatsapp.net", fromMe: false },
    message: { conversation: "oi" },
    messageTimestamp: 1735689600,
  });
  const [first] = normalizeWhatsAppEvent(payload);
  const [second] = normalizeWhatsAppEvent(payload);
  assertEquals(first.providerMessageId, second.providerMessageId);
  assertEquals(first.providerMessageId.startsWith("synthetic:"), true);
});

Deno.test("evento que não é messages.upsert é ignorado inteiro", () => {
  assertEquals(normalizeWhatsAppEvent({ event: "connection.update", data: {} }).length, 0);
});
