// Respostas HTTP e log. Log é sempre JSON de uma linha (fácil de filtrar no
// painel do Supabase) e nunca carrega secret, chave ou payload inteiro.

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function log(event: string, data: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/key|secret|token|authorization|apikey/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ event, ...safe, at: new Date().toISOString() }));
}

/** Fetch com timeout — sem isso uma dependência lenta trava a function inteira. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Comparação de secrets em tempo constante. Comparar com === vaza o
 * comprimento do prefixo correto por tempo de resposta.
 */
export function secretMatches(received: string | null, expected: string): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(received ?? "");
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
