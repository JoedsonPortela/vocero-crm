/**
 * Catálogo do provedor de IA (Ajustes → IA). Sem imports de servidor: também o
 * leem os componentes de cliente.
 *
 * Um preset é só uma ajuda para não escrever a `base_url` à mão. O que
 * identifica o provedor no banco é a `base_url`: qualquer API
 * compatível com a da OpenAI serve (OpenRouter, OpenAI, Groq, um vLLM
 * próprio…), que é a única fronteira com o LLM que a constituição admite.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

export const AI_PROVIDERS = ["openrouter", "openai_compatible"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const AI_STATUSES = [
  "active",
  "paused_invalid_token",
  "paused_no_credit",
] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

export type AiProviderPreset = {
  id: AiProviderId;
  label: string;
  /** Fixo no preset; `null` = quem escreve é o dono. */
  baseUrl: string | null;
  modelPlaceholder: string;
  tokenPlaceholder: string;
};

export const AI_PROVIDER_PRESETS: Record<AiProviderId, AiProviderPreset> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: OPENROUTER_BASE_URL,
    modelPlaceholder: "anthropic/claude-sonnet-4.5",
    tokenPlaceholder: "sk-or-…",
  },
  openai_compatible: {
    id: "openai_compatible",
    label: "Outro compatível com OpenAI",
    baseUrl: null,
    modelPlaceholder: "gpt-4.1-mini",
    tokenPlaceholder: "sk-…",
  },
};

export const AI_STATUS_LABEL: Record<AiStatus, string> = {
  active: "Activo",
  paused_invalid_token: "Pausado: llave rechazada",
  paused_no_credit: "Pausado: sin saldo",
};

/** A qual preset corresponde uma base URL (a do ambiente ou uma salva). */
export function presetDeBaseUrl(baseUrl: string): AiProviderId {
  return apiRoot(baseUrl) === apiRoot(OPENROUTER_BASE_URL)
    ? "openrouter"
    : "openai_compatible";
}

/**
 * A raiz `/v1` de uma API compatível com OpenAI.
 *
 * A convenção do repositório é a base SEM `/v1` (`https://openrouter.ai/api`),
 * mas metade da internet publica a sua COM ele (`https://api.groq.com/openai/v1`).
 * Aceitam-se as duas: se já termina em `/v1` não é duplicado. Com a antiga
 * concatenação cega, colar a segunda dava `/v1/v1/chat/completions` e
 * um 404 que não explicava nada.
 */
export function apiRoot(baseUrl: string): string {
  const sinBarra = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(sinBarra) ? sinBarra : `${sinBarra}/v1`;
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${apiRoot(baseUrl)}/chat/completions`;
}

export function modelsUrl(baseUrl: string): string {
  return `${apiRoot(baseUrl)}/models`;
}

/** Os últimos 4 do token: o único que vai para a UI. */
export function last4(token: string): string {
  return token.slice(-4);
}
