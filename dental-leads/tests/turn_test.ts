// deno test --allow-env dental-leads/tests/
//
// Peças puras do motor de turno. O que depende de Postgres (debounce, lock,
// lease, stale, corrida SENDING/reconciler) é testado em
// tests/db/turn_engine_test.sql, tests/db/bubble_sequencing_test.sql e
// tests/db/prerelease_validation_test.sql — corrida não se testa com mock.

import { assertEquals } from "jsr:@std/assert@1";
import { contentHash, extractLinks } from "../supabase/functions/_shared/normalize.ts";
import {
  naturalDelayMs,
  outcomeForInvalidTurn,
  shouldYieldOnBudgetExceeded,
} from "../supabase/functions/_shared/turn.ts";

Deno.test("links recebidos são preservados inteiros", () => {
  assertEquals(
    extractLinks("olha isso https://instagram.com/p/abc-123 e www.clinica.com.br"),
    ["https://instagram.com/p/abc-123", "www.clinica.com.br"],
  );
  assertEquals(extractLinks("oi, tudo bem?"), []);
});

Deno.test("link repetido não é duplicado", () => {
  assertEquals(
    extractLinks("https://x.com/a e de novo https://x.com/a"),
    ["https://x.com/a"],
  );
});

Deno.test("content_hash ignora caixa e espaço, mas não conteúdo", async () => {
  assertEquals(await contentHash("Claro 😊"), await contentHash("  claro 😊 "));
  const a = await contentHash("Claro 😊");
  const b = await contentHash("Claro!");
  assertEquals(a === b, false);
});

Deno.test("delay natural fica dentro da faixa configurada", () => {
  for (let i = 0; i < 50; i++) {
    const delay = naturalDelayMs(2000, 5000);
    assertEquals(delay >= 2000 && delay <= 5000, true, `fora da faixa: ${delay}`);
  }
});

Deno.test("takeover no meio do turno tem desfecho próprio", () => {
  assertEquals(outcomeForInvalidTurn("human_takeover", 0), "HUMAN_TAKEOVER");
  assertEquals(outcomeForInvalidTurn("human_takeover", 2), "HUMAN_TAKEOVER");
});

Deno.test("stale antes de qualquer bolha ≠ stale no meio da sequência", () => {
  // Sem bolha enviada: o batch volta inteiro para o próximo turno.
  assertEquals(outcomeForInvalidTurn("stale_nova_mensagem", 0), "STALE_BEFORE_SEND");
  // Com bolha já entregue: o que saiu está dito, o resto é cancelado.
  assertEquals(outcomeForInvalidTurn("stale_nova_mensagem", 1), "PARTIAL_STALE");
});

Deno.test("perder o lease impede envio, mesmo sem mensagem nova", () => {
  assertEquals(outcomeForInvalidTurn("lease_perdido", 0), "STALE_BEFORE_SEND");
});

// ---------------------------------------------------------------------------
// Ponto 4 da validação pré-F3: yield só é permitido antes da 1ª bolha SENT.
// Regra isolada de propósito — é o jeito mais direto de garantir que o
// worker nunca devolve um turno que já produziu efeito colateral observável
// (uma mensagem que o lead já recebeu) para ser recomeçado do zero.
// ---------------------------------------------------------------------------
Deno.test("yield permitido só quando nenhuma bolha foi enviada ainda", () => {
  assertEquals(shouldYieldOnBudgetExceeded(0), true);
});

Deno.test("yield NUNCA permitido depois de pelo menos 1 bolha SENT", () => {
  for (const sent of [1, 2, 3, 10]) {
    assertEquals(shouldYieldOnBudgetExceeded(sent), false, `bubblesSent=${sent}`);
  }
});
