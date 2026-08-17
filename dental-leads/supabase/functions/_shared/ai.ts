// Camada de IA: UMA chamada por mensagem elegível, com saída estruturada.
//
// A mesma chamada devolve intenção, interesse, etapa sugerida, ação, risco,
// confiança, necessidade de humano, resposta e resumo atualizado. Não existe
// segunda chamada, não existe segundo agente, não existe supervisor.
//
// Trocar de provedor/modelo é trocar env: AI_PROVIDER, AI_MODEL, AI_API_KEY
// (e AI_BASE_URL para provedores compatíveis com OpenAI).

import { config } from "./config.ts";
import { fetchWithTimeout, log } from "./http.ts";
import type { PolicyCategory } from "./policy.ts";

export interface AiSuggestion {
  intent: string;
  treatment_interest: string | null;
  stage: string;
  action: "AUTO_REPLY" | "HUMAN" | "IGNORE";
  risk: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  needs_human: boolean;
  human_reason: string | null;
  /**
   * 1 a MAX_BUBBLES mensagens curtas, na ordem em que devem sair. Vazio
   * quando action != AUTO_REPLY. É o que sustenta o envio sequencial em
   * bolhas — o conteúdo comercial (playbook, objeções, temperatura) fica
   * para a Fase 3; aqui só muda a FORMA da resposta.
   */
  reply_messages: string[];
  summary: string | null;
}

export interface AiContextMessage {
  direction: "IN" | "OUT";
  text: string;
}

export interface AiInput {
  category: PolicyCategory;
  leadName: string | null;
  currentStage: string;
  treatmentInterest: string | null;
  conversationSummary: string | null;
  recentMessages: AiContextMessage[];
  /**
   * A rajada atual: tudo que o lead escreveu desde a última resposta, em
   * ordem. É UMA unidade conversacional, uma chamada de IA — não uma chamada
   * por mensagem.
   */
  currentMessages: string[];
}

// Schema único, compartilhado pelos dois provedores.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", description: "Intenção principal em uma palavra ou expressão curta." },
    treatment_interest: {
      type: ["string", "null"],
      description: "Tratamento de interesse identificado, ou null se ainda não ficou claro.",
    },
    stage: { type: "string", enum: ["NEW", "CONVERSATION", "INTEREST", "SCHEDULING"] },
    action: { type: "string", enum: ["AUTO_REPLY", "HUMAN", "IGNORE"] },
    risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needs_human: { type: "boolean" },
    human_reason: { type: ["string", "null"] },
    reply_messages: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 3,
      description:
        "1 a 3 mensagens curtas, na ordem em que devem ser enviadas (como bolhas separadas do WhatsApp). Lista vazia se action != AUTO_REPLY.",
    },
    summary: {
      type: ["string", "null"],
      description: "Resumo atualizado da conversa em até 2 frases. É a memória do lead.",
    },
  },
  required: [
    "intent", "treatment_interest", "stage", "action", "risk",
    "confidence", "needs_human", "human_reason", "reply_messages", "summary",
  ],
  additionalProperties: false,
} as const;

function buildSystemPrompt(category: PolicyCategory): string {
  const clinic = config.clinic;
  const location = [clinic.address, clinic.city].filter(Boolean).join(" — ");

  const categoryRule = category === "YELLOW"
    ? `ATENÇÃO: esta mensagem toca em preço/pagamento. Você PODE explicar como funciona o processo e convidar para a avaliação, mas NUNCA cite valores, faixas de preço, parcelas ou descontos. Diga que a equipe passa os valores certinho porque depende do caso.`
    : `Assunto comercial/informativo comum. Responda com naturalidade.`;

  return `Você é a secretária de atendimento (CRC) da clínica odontológica ${clinic.name}. Você atende leads pelo WhatsApp.

Sobre a clínica:
- Tratamentos oferecidos: ${clinic.treatments}
${location ? `- Localização: ${location}\n` : ""}${clinic.hours ? `- Horário de atendimento: ${clinic.hours}\n` : ""}
Seu objetivo: acolher, entender o interesse, tirar dúvidas comerciais simples e conduzir naturalmente até uma avaliação — sem pressão.

Como você escreve:
- A resposta sai em 1 a 3 mensagens curtas separadas (bolhas de WhatsApp), não um texto único. Cada bolha é curta — uma ideia por vez.
- Linguagem humana, calorosa e brasileira. Um emoji no máximo por bolha, quando couber.
- Uma pergunta por vez, na última bolha.
- Nunca soa como robô, formulário ou script.

O que você NUNCA faz:
- diagnosticar, opinar sobre sintoma, dor, inchaço, sangramento ou urgência;
- prescrever ou comentar medicamento, anestesia, alergia ou contraindicação;
- interpretar exame, raio-x ou foto;
- prometer ou garantir resultado;
- inventar preço, prazo, promoção ou informação que não está aqui;
- fingir ser dentista ou dar qualquer orientação clínica.

Se a mensagem pedir qualquer uma dessas coisas, ou se a pessoa pedir para falar com alguém da equipe: action = "HUMAN", needs_human = true e reply_messages = [].

${categoryRule}

Sobre a etapa do funil (campo stage), sugira com base na conversa:
- NEW: primeiro contato, ainda sem interação real.
- CONVERSATION: a conversa começou, interesse ainda vago.
- INTEREST: um tratamento ou objetivo específico ficou claro.
- SCHEDULING: a pessoa demonstra intenção concreta de marcar avaliação/consulta.
Você não decide conversão nem perda — essas etapas não existem para você.

O campo summary é a memória desse lead: reescreva em até 2 frases o que importa da conversa até aqui (interesse, contexto, o que já foi perguntado).

Responda somente pelo formato estruturado.`;
}

function buildUserPrompt(input: AiInput): string {
  const history = input.recentMessages
    .map((m) => `${m.direction === "IN" ? "Lead" : "Clínica"}: ${m.text}`)
    .join("\n");

  // A rajada chega como um bloco só: o lead terminou de escrever antes de a
  // IA ser chamada, então ela responde à mensagem inteira, não a um pedaço.
  const batch = input.currentMessages.map((text) => `- ${text}`).join("\n");

  return [
    `Lead: ${input.leadName ?? "(nome não informado)"}`,
    `Etapa atual: ${input.currentStage}`,
    `Interesse registrado: ${input.treatmentInterest ?? "(nenhum ainda)"}`,
    `Resumo da conversa até agora: ${input.conversationSummary ?? "(primeiro contato)"}`,
    "",
    history ? `Últimas mensagens:\n${history}` : "Sem mensagens anteriores.",
    "",
    input.currentMessages.length > 1
      ? `Mensagens novas do lead (ele mandou várias seguidas — responda a tudo de uma vez):\n${batch}`
      : `Mensagem nova do lead: ${input.currentMessages[0] ?? ""}`,
  ].join("\n");
}

async function callAnthropic(system: string, user: string): Promise<unknown> {
  const response = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.ai.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: config.ai.maxTokens,
        temperature: config.ai.temperature,
        system,
        messages: [{ role: "user", content: user }],
        // Saída estruturada via tool forçada: é o caminho confiável para
        // receber sempre o mesmo formato.
        tools: [{
          name: "registrar_analise",
          description: "Registra a análise do lead e a resposta sugerida.",
          input_schema: OUTPUT_SCHEMA,
        }],
        tool_choice: { type: "tool", name: "registrar_analise" },
      }),
    },
    config.ai.timeoutMs,
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`anthropic_http_${response.status}: ${JSON.stringify(data?.error ?? {})}`);
  }

  const block = Array.isArray(data?.content)
    ? data.content.find((c: Record<string, unknown>) => c?.type === "tool_use")
    : null;
  if (!block?.input) throw new Error("anthropic_sem_tool_use");
  return block.input;
}

async function callOpenAiCompatible(system: string, user: string): Promise<unknown> {
  const baseUrl = (config.ai.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

  const response = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: config.ai.temperature,
        max_tokens: config.ai.maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "analise_lead", strict: true, schema: OUTPUT_SCHEMA },
        },
      }),
    },
    config.ai.timeoutMs,
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`openai_http_${response.status}: ${JSON.stringify(data?.error ?? {})}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("openai_sem_conteudo");
  return JSON.parse(content);
}

/**
 * Validação no backend. JSON fora do contrato = nada é enviado (item 19).
 * Nunca "consertar na marra" o que o modelo devolveu.
 */
export function validateSuggestion(raw: unknown): { ok: true; value: AiSuggestion } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "resposta_nao_e_objeto" };
  const data = raw as Record<string, unknown>;

  const action = data.action;
  if (action !== "AUTO_REPLY" && action !== "HUMAN" && action !== "IGNORE") {
    return { ok: false, error: `action_invalida:${String(action)}` };
  }

  const risk = data.risk;
  if (risk !== "LOW" && risk !== "MEDIUM" && risk !== "HIGH") {
    return { ok: false, error: `risk_invalido:${String(risk)}` };
  }

  const confidence = typeof data.confidence === "number" ? data.confidence : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: `confidence_invalida:${String(data.confidence)}` };
  }

  const stage = typeof data.stage === "string" ? data.stage.toUpperCase() : "";
  if (!["NEW", "CONVERSATION", "INTEREST", "SCHEDULING"].includes(stage)) {
    return { ok: false, error: `stage_invalida:${stage}` };
  }

  const rawMessages = Array.isArray(data.reply_messages) ? data.reply_messages : [];
  const replyMessages = rawMessages
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (action === "AUTO_REPLY" && replyMessages.length === 0) {
    return { ok: false, error: "auto_reply_sem_texto" };
  }
  if (replyMessages.length > config.turn.maxBubbles) {
    return { ok: false, error: `reply_messages_excede_limite:${replyMessages.length}` };
  }
  if (replyMessages.some((message) => message.length > config.ai.maxReplyChars)) {
    return { ok: false, error: "reply_excede_tamanho" };
  }

  const asText = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  return {
    ok: true,
    value: {
      intent: asText(data.intent) ?? "desconhecido",
      treatment_interest: asText(data.treatment_interest),
      stage,
      action,
      risk,
      confidence,
      needs_human: data.needs_human === true,
      human_reason: asText(data.human_reason),
      reply_messages: replyMessages,
      summary: asText(data.summary),
    },
  };
}

export async function analyzeMessage(
  input: AiInput,
): Promise<{ ok: true; value: AiSuggestion; raw: unknown } | { ok: false; error: string; raw: unknown }> {
  const system = buildSystemPrompt(input.category);
  const user = buildUserPrompt(input);

  let raw: unknown;
  try {
    raw = config.ai.provider === "openai"
      ? await callOpenAiCompatible(system, user)
      : await callAnthropic(system, user);
  } catch (error) {
    log("ai_erro_chamada", { provider: config.ai.provider, model: config.ai.model, erro: String(error) });
    return { ok: false, error: `chamada_falhou: ${String(error)}`, raw: null };
  }

  const validated = validateSuggestion(raw);
  if (!validated.ok) {
    log("ai_json_invalido", { erro: validated.error });
    return { ok: false, error: `invalid_ai_json:${validated.error}`, raw };
  }

  return { ok: true, value: validated.value, raw };
}
