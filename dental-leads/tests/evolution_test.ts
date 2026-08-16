// deno test --allow-env dental-leads/tests/
//
// Classificação de falha HTTP: a diferença entre "retentar" e "não retentar"
// não pode depender de leitura na hora — precisa estar testada.

import { assertEquals } from "jsr:@std/assert@1";
import { classifyHttpFailure } from "../supabase/functions/_shared/evolution.ts";

Deno.test("4xx permanente: retentar não muda o resultado", () => {
  for (const status of [400, 401, 403, 404, 405, 409, 410, 413, 415, 422]) {
    assertEquals(classifyHttpFailure(status), "PERMANENT_FAILURE", `status ${status}`);
  }
});

Deno.test("429 é retryable: a própria Evolution está pedindo para esperar", () => {
  assertEquals(classifyHttpFailure(429), "RETRYABLE_FAILURE");
});

Deno.test("5xx é incerto, nunca falha definitiva (pode ter entregue antes de quebrar)", () => {
  for (const status of [500, 502, 503, 504]) {
    assertEquals(classifyHttpFailure(status), "UNKNOWN", `status ${status}`);
  }
});
