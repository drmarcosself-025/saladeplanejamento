// Evolution API — usada exclusivamente como gateway de WhatsApp.
//
// Este projeto NÃO instala, configura nem altera a Evolution: só consome a
// instância que já existe. Aqui há um único verbo: enviar texto.

import { config } from "./config.ts";
import { fetchWithTimeout, log } from "./http.ts";

/**
 * SENT               = a Evolution confirmou o envio.
 * RETRYABLE_FAILURE  = recusa que tende a passar com o tempo (429 — limite de
 *                      taxa da própria Evolution). Não foi entregue; vale a
 *                      pena retentar com backoff, que é exatamente o que o
 *                      job já faz.
 * PERMANENT_FAILURE  = recusa que não vai se resolver tentando de novo (400,
 *                      401, 403, 404, 422...). Não foi entregue; retentar é
 *                      desperdício e pode até martelar a API. Vira caso
 *                      humano na hora, sem gastar tentativa de job.
 * UNKNOWN            = timeout, erro de rede ou 5xx. Pode OU NÃO ter sido
 *                      entregue — NUNCA reenviar automaticamente, sob pena de
 *                      duplicar para o lead.
 */
export type SendStatus = "SENT" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "UNKNOWN";

export interface SendResult {
  status: SendStatus;
  providerMessageId: string | null;
  error?: string;
}

/**
 * 5xx pode ter entregue antes de falhar (o corpo às vezes só quebra na volta):
 * trata-se como incerteza, não como falha, para nunca arriscar reenviar algo
 * que já chegou. 429 é a própria Evolution pedindo para esperar — é
 * literalmente o caso de uso do backoff exponencial que o job já tem. O resto
 * dos 4xx é rejeição de verdade (número inválido, sem permissão, payload
 * ruim) — insistir não muda o resultado.
 */
export function classifyHttpFailure(status: number): SendStatus {
  if (status >= 500) return "UNKNOWN";
  if (status === 429) return "RETRYABLE_FAILURE";
  return "PERMANENT_FAILURE";
}

/**
 * @param destination telefone real quando conhecido; senão o próprio JID que a
 *                    Evolution nos entregou (nunca um LID convertido "na mão").
 */
export async function sendText(destination: string, text: string): Promise<SendResult> {
  const url = `${config.evolution.apiUrl}/message/sendText/${config.evolution.instance}`;
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: config.evolution.apiKey },
        body: JSON.stringify({
          number: destination,
          text,
          delay: config.evolution.sendDelayMs,
        }),
      },
      config.evolution.timeoutMs,
    );

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const status = classifyHttpFailure(response.status);
      log("evolution_envio_falhou", { httpStatus: response.status, status, ms: Date.now() - startedAt });
      return { status, providerMessageId: null, error: `http_${response.status}` };
    }

    // O id devolvido aqui é o que permite distinguir depois "mensagem nossa"
    // de "humano respondeu pelo celular" (human takeover).
    const providerMessageId: string | null = body?.key?.id ?? body?.messageId ?? null;
    log("evolution_envio_ok", {
      ms: Date.now() - startedAt,
      temId: Boolean(providerMessageId),
      chars: text.length,
    });
    return { status: "SENT", providerMessageId };
  } catch (error) {
    // Timeout ou erro de rede: a mensagem pode ter chegado. Incerteza é
    // registrada como tal e resolvida por uma pessoa.
    log("evolution_envio_incerto", { erro: String(error), ms: Date.now() - startedAt });
    return { status: "UNKNOWN", providerMessageId: null, error: String(error) };
  }
}
