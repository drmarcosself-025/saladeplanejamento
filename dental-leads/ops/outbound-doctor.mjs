// outbound-doctor — isola a camada de envio (Evolution) do resto do sistema.
//
// Não toca em Supabase, IA, webhook nem lead-worker. Só testa, na ordem:
//   1. saúde da instância na Evolution (conectada?)
//   2. um sendText direto, cronometrado, com timeout curto e explícito
//   3. imprime tudo (tempo, status HTTP, corpo da resposta) pra decidir se o
//      problema está na Evolution/rede, ou em outro lugar do worker.
//
// Uso:
//   node ops/outbound-doctor.mjs <numero_destino>
//
// Lê as variáveis direto do .env na mesma pasta (dental-leads/).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");

function loadEnv(path) {
  const out = {};
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function mask(value) {
  if (!value) return "(vazio)";
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "*".repeat(value.length - 8) + value.slice(-4);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;
    return { response, elapsedMs, timedOut: false };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const timedOut = error?.name === "AbortError";
    return { error, elapsedMs, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function line() {
  console.log("-".repeat(70));
}

async function main() {
  const destination = process.argv[2];
  if (!destination) {
    console.error("Uso: node ops/outbound-doctor.mjs <numero_destino_sem_simbolos>");
    console.error("Exemplo: node ops/outbound-doctor.mjs 5527996916295");
    process.exit(1);
  }

  console.log("OUTBOUND DOCTOR");
  console.log("Isola a camada Evolution — não toca em Supabase/IA/webhook.\n");

  let env;
  try {
    env = loadEnv(envPath);
  } catch (error) {
    console.error(`Não consegui ler ${envPath}: ${error.message}`);
    process.exit(1);
  }

  const apiUrl = (env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
  const instance = env.EVOLUTION_INSTANCE || "";
  const apiKey = env.EVOLUTION_API_KEY || "";
  const timeoutMs = Number(env.EVOLUTION_TIMEOUT_MS || "15000");
  const sendDelayMs = Number(env.EVOLUTION_SEND_DELAY_MS || "1500");

  console.log("Config lida do .env:");
  console.log(`  EVOLUTION_API_URL     = ${apiUrl || "(vazio — PARE, preencha o .env)"}`);
  console.log(`  EVOLUTION_INSTANCE    = ${instance || "(vazio — PARE, preencha o .env)"}`);
  console.log(`  EVOLUTION_API_KEY     = ${mask(apiKey)}`);
  console.log(`  EVOLUTION_TIMEOUT_MS  = ${timeoutMs}`);
  console.log(`  destino               = ${destination}`);
  line();

  if (!apiUrl || !instance || !apiKey) {
    console.error("Faltam variáveis obrigatórias no .env. Corrija antes de continuar.");
    process.exit(1);
  }

  // --- Passo 1: saúde/estado da instância -----------------------------------
  console.log("\n[1/2] Checando estado da instância na Evolution...");
  const stateUrl = `${apiUrl}/instance/connectionState/${instance}`;
  const stateResult = await fetchWithTimeout(
    stateUrl,
    { method: "GET", headers: { apikey: apiKey } },
    10000,
  );

  if (stateResult.error) {
    console.log(`  ✗ FALHOU em ${stateResult.elapsedMs}ms — ${stateResult.timedOut ? "TIMEOUT (10s)" : stateResult.error.message}`);
    console.log("  → Se travou aqui, o problema é rede/DNS/Evolution fora do ar — nem chega no sendText.");
  } else {
    const body = await stateResult.response.text();
    console.log(`  Status HTTP: ${stateResult.response.status} — respondeu em ${stateResult.elapsedMs}ms`);
    console.log(`  Corpo: ${body.slice(0, 300)}`);
    if (stateResult.response.ok) {
      console.log("  ✓ Instância respondeu.");
    } else {
      console.log("  ✗ Instância respondeu com erro HTTP — confira instance/apikey.");
    }
  }
  line();

  // --- Passo 2: sendText isolado, cronometrado, com timeout explícito -------
  console.log("\n[2/2] Mandando sendText isolado (fora do lead-worker)...");
  const sendUrl = `${apiUrl}/message/sendText/${instance}`;
  const text = `[outbound-doctor] teste isolado ${new Date().toISOString()}`;

  const sendResult = await fetchWithTimeout(
    sendUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ number: destination, text, delay: sendDelayMs }),
    },
    timeoutMs,
  );

  if (sendResult.error) {
    console.log(`  ✗ FALHOU em ${sendResult.elapsedMs}ms — ${sendResult.timedOut ? `TIMEOUT (${timeoutMs}ms)` : sendResult.error.message}`);
    console.log("  → Se travou/deu timeout AQUI (fora do worker, chamada isolada), o problema");
    console.log("    é genuinamente a Evolution/rede — não é bug no lead-worker.");
  } else {
    const body = await sendResult.response.text();
    console.log(`  Status HTTP: ${sendResult.response.status} — respondeu em ${sendResult.elapsedMs}ms`);
    console.log(`  Corpo: ${body.slice(0, 500)}`);
    if (sendResult.response.ok) {
      console.log("  ✓ Envio isolado funcionou. Confere no WhatsApp de destino se a mensagem chegou.");
      console.log("  → Se funcionou AQUI mas o lead-worker trava, o problema está no worker");
      console.log("    (lógica de reserva/advance/finalize), não na Evolution.");
    } else {
      console.log("  ✗ Evolution recusou o envio (HTTP não-2xx) — confira o corpo acima pro motivo exato.");
    }
  }
  line();

  console.log("\nResumo:");
  console.log(`  Estado da instância: ${stateResult.error ? "FALHOU" : stateResult.response.ok ? "OK" : "ERRO HTTP"}`);
  console.log(`  sendText isolado:    ${sendResult.error ? (sendResult.timedOut ? "TIMEOUT" : "FALHOU") : sendResult.response.ok ? "OK" : "ERRO HTTP"}`);
  console.log("\nPróximo passo sugerido:");
  if (sendResult.error || (!sendResult.error && !sendResult.response.ok)) {
    console.log("  A falha está na camada Evolution/rede. Cruze o horário acima com os logs");
    console.log("  do serviço Evolution API no Railway (mesmo segundo) antes de mexer no código.");
  } else {
    console.log("  A Evolution respondeu bem isolada. Se o lead-worker ainda travar,");
    console.log("  o problema é na integração dele com evolution.ts (reserve/advance/finalize),");
    console.log("  não na Evolution em si.");
  }
}

main().catch((error) => {
  console.error("Erro inesperado no outbound-doctor:", error);
  process.exit(1);
});
