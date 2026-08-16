// Evolution API — usada exclusivamente como gateway de WhatsApp.
//
// Este projeto NÃO instala, configura nem altera a Evolution: só consome a
// instância que já existe. Aqui há um único verbo: enviar texto.

import { config } from "./config.ts";
import { fetchWithTimeout, log } from "./http.ts";

export interface SendResult {
  ok: boolean;
  providerMessageId: string | null;
  error?: string;
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
      log("evolution_envio_falhou", { status: response.status, ms: Date.now() - startedAt });
      return { ok: false, providerMessageId: null, error: `http_${response.status}` };
    }

    // O id devolvido aqui é o que permite distinguir depois "mensagem nossa"
    // de "humano respondeu pelo celular" (human takeover).
    const providerMessageId: string | null = body?.key?.id ?? body?.messageId ?? null;
    log("evolution_envio_ok", {
      ms: Date.now() - startedAt,
      temId: Boolean(providerMessageId),
      chars: text.length,
    });
    return { ok: true, providerMessageId };
  } catch (error) {
    log("evolution_envio_excecao", { erro: String(error), ms: Date.now() - startedAt });
    return { ok: false, providerMessageId: null, error: String(error) };
  }
}
