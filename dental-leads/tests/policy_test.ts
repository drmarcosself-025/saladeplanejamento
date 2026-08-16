// deno test --allow-env dental-leads/tests/
//
// A política é o que impede a IA de causar dano. Estes casos são o contrato:
// se um deles quebrar, alguma resposta clínica ou algum preço inventado passou.

import { assertEquals } from "jsr:@std/assert@1";
import {
  classifyText,
  containsMoney,
  evaluatePostPolicy,
  evaluatePrePolicy,
} from "../supabase/functions/_shared/policy.ts";
import { canSendMessage } from "../supabase/functions/_shared/ratelimit.ts";
import { resolveStage } from "../supabase/functions/_shared/funnel.ts";

const semLimite = { last_turn_at: null, last_out_text: null, turn_hour_count: 0, turn_day_count: 0 };

Deno.test("sintoma clínico é VERMELHO", () => {
  for (const texto of [
    "Estou com muita dor no dente",
    "Minha gengiva está sangrando",
    "Acho que inchou depois da cirurgia",
    "Posso tomar antibiótico?",
    "Quero falar com atendente",
  ]) {
    assertEquals(classifyText(texto).category, "RED", texto);
  }
});

Deno.test("assunto de preço é AMARELO", () => {
  for (const texto of ["Quanto custa o Invisalign?", "Vocês parcelam?", "Aceita plano odontológico?"]) {
    assertEquals(classifyText(texto).category, "YELLOW", texto);
  }
});

Deno.test("pergunta comercial comum é VERDE", () => {
  for (const texto of [
    "Oi, queria saber como funciona o alinhador",
    "Vocês ficam onde?",
    "Que horas vocês abrem?",
    "Quero melhorar meu sorriso",
  ]) {
    assertEquals(classifyText(texto).category, "GREEN", texto);
  }
});

Deno.test("fronteira de palavra: 'dor' não casa dentro de 'dormir'", () => {
  assertEquals(classifyText("Só consigo dormir tarde").category, "GREEN");
  assertEquals(classifyText("Adorei o atendimento").category, "GREEN");
});

Deno.test("mídia nunca chega na IA na V1", () => {
  const result = evaluatePrePolicy({
    text: "",
    messageTypes: ["AUDIO"],
    automationStatus: "ACTIVE",
    needsHuman: false,
  });
  assertEquals(result.allowAi, false);
  assertEquals(result.needsHuman, true);
  assertEquals(typeof result.handoffMessage, "string");
});

Deno.test("figurinha sozinha não vale uma chamada de IA nem resposta", () => {
  const result = evaluatePrePolicy({
    text: "",
    messageTypes: ["STICKER"],
    automationStatus: "ACTIVE",
    needsHuman: false,
  });
  assertEquals(result.allowAi, false);
  assertEquals(result.needsHuman, false);
  assertEquals(result.handoffMessage, null);
  assertEquals(result.reason, "sticker_isolado");
});

Deno.test("figurinha acompanhada de texto processa o texto", () => {
  const result = evaluatePrePolicy({
    text: "quero saber do clareamento",
    messageTypes: ["STICKER", "TEXT"],
    automationStatus: "ACTIVE",
    needsHuman: false,
  });
  assertEquals(result.allowAi, true);
});

Deno.test("rajada com mídia no meio vira caso humano", () => {
  const result = evaluatePrePolicy({
    text: "olha como está meu dente",
    messageTypes: ["TEXT", "IMAGE"],
    automationStatus: "ACTIVE",
    needsHuman: false,
  });
  assertEquals(result.allowAi, false);
  assertEquals(result.needsHuman, true);
});

Deno.test("automação pausada não gasta IA", () => {
  const result = evaluatePrePolicy({
    text: "oi, quanto custa?",
    messageTypes: ["TEXT"],
    automationStatus: "PAUSED",
    needsHuman: false,
  });
  assertEquals(result.allowAi, false);
  assertEquals(result.handoffMessage, null);
});

Deno.test("resposta com valor monetário é bloqueada", () => {
  assertEquals(containsMoney("fica R$ 3.500 à vista"), true);
  assertEquals(containsMoney("dá pra fazer em 12x de 300"), true);
  assertEquals(containsMoney("a avaliação é gratuita"), false);

  const result = evaluatePostPolicy({
    category: "YELLOW",
    reply: "O Invisalign fica R$ 15.000",
    action: "AUTO_REPLY",
    confidence: 0.99,
    needsHuman: false,
  });
  assertEquals(result.allowSend, false);
  assertEquals(result.needsHuman, true);
});

Deno.test("resposta com conteúdo clínico é bloqueada mesmo com confiança alta", () => {
  const result = evaluatePostPolicy({
    category: "GREEN",
    reply: "Pelo que você descreveu, provavelmente é um caso de canal.",
    action: "AUTO_REPLY",
    confidence: 0.98,
    needsHuman: false,
  });
  assertEquals(result.allowSend, false);
});

Deno.test("confiança baixa não vira envio automático", () => {
  const result = evaluatePostPolicy({
    category: "GREEN",
    reply: "Claro, posso te ajudar 😊",
    action: "AUTO_REPLY",
    confidence: 0.2,
    needsHuman: false,
  });
  assertEquals(result.allowSend, false);
});

Deno.test("resposta comercial aprovada passa nas duas passagens", () => {
  const result = evaluatePostPolicy({
    category: "GREEN",
    reply: "Claro 😊 Você já usou aparelho antes ou seria o primeiro tratamento?",
    action: "AUTO_REPLY",
    confidence: 0.93,
    needsHuman: false,
  });
  assertEquals(result.allowSend, true);
});

Deno.test("rate limit: intervalo mínimo bloqueia envio em rajada", () => {
  const result = canSendMessage({
    stats: { ...semLimite, last_turn_at: new Date().toISOString() },
    automationStatus: "ACTIVE",
    needsHuman: false,
    replyText: "oi",
    purpose: "AI_REPLY",
  });
  assertEquals(result.allowed, false);
});

Deno.test("rate limit: resposta idêntica à anterior é anti-loop", () => {
  const result = canSendMessage({
    stats: { ...semLimite, last_out_text: "Claro 😊" },
    automationStatus: "ACTIVE",
    needsHuman: false,
    replyText: "claro 😊",
    purpose: "AI_REPLY",
  });
  assertEquals(result.allowed, false);
});

Deno.test("rate limit: takeover humano bloqueia até a mensagem neutra", () => {
  for (const purpose of ["AI_REPLY", "HANDOFF"] as const) {
    const result = canSendMessage({
      stats: semLimite,
      automationStatus: "HUMAN_TAKEOVER",
      needsHuman: true,
      replyText: "oi",
      purpose,
    });
    assertEquals(result.allowed, false, purpose);
  }
});

Deno.test("funil: IA nunca converte nem perde lead", () => {
  assertEquals(resolveStage("INTEREST", "CONVERTED", true).stage, "INTEREST");
  assertEquals(resolveStage("INTEREST", "LOST", true).stage, "INTEREST");
});

Deno.test("funil: não anda para trás e avança um degrau por vez", () => {
  assertEquals(resolveStage("INTEREST", "CONVERSATION", true).stage, "INTEREST");
  assertEquals(resolveStage("NEW", "SCHEDULING", true).stage, "INTEREST");
});

Deno.test("funil: etapa final só muda manualmente", () => {
  assertEquals(resolveStage("CONVERTED", "SCHEDULING", true).changed, false);
  assertEquals(resolveStage("LOST", "INTEREST", true).changed, false);
});

Deno.test("funil: responder um lead novo já o tira de NEW", () => {
  assertEquals(resolveStage("NEW", "NEW", true).stage, "CONVERSATION");
});
