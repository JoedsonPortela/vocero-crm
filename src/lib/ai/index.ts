import type { z } from "zod";
import { chatCompletionsUrl } from "@/lib/ai/presets";
import {
  resolveAiProvider,
  type AiProvider,
  type EstadoIa,
} from "@/lib/ai/provider";
import { marcarEstadoPorRespuesta } from "@/server/ai/credentials";

/**
 * Adaptador LLM compatível com OpenRouter — ÚNICA fronteira com o provedor de IA
 * (Constituição II). Regra operacional: a saída do modelo é imprevisível;
 * todo consumo passa por extração robusta + Zod + novas tentativas, e uma falha pontual do
 * provedor jamais propaga exceção (resultado `error` tipado).
 *
 * Com quem fala quem decide é `lib/ai/provider.ts`: a linha de Ajustes → IA da
 * organização, e se não houver, as variáveis `OPENROUTER_*` do ambiente.
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatJsonResult<T> =
  | { ok: true; data: T; raw: string }
  | { ok: false; error: "not_configured" | "provider_error" | "invalid_output"; detail: string };

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** O provedor respondeu com um código HTTP de erro. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`proveedor respondió ${status}: ${truncate(body)}`);
    this.name = "ProviderHttpError";
  }
}

export async function chatJson<T>(
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts?: {
    model?: string;
    judge?: boolean;
    timeoutMs?: number;
    /**
     * De quem é a configuração com a qual esta chamada é paga. Sem ela
     * só conta o ambiente: não há linha para consultar nem para pausar.
     */
    organizationId?: string;
  }
): Promise<ChatJsonResult<T>> {
  const resolved = await resolveAiProvider(opts?.organizationId);
  if (!resolved.ok) {
    return {
      ok: false,
      error: "not_configured",
      detail: detalleNoConfigurado(resolved.estado),
    };
  }
  const provider = resolved.provider;
  const model =
    opts?.model ?? (opts?.judge ? provider.judgeModel : provider.model);
  if (!model?.trim()) {
    return {
      ok: false,
      error: "not_configured",
      detail: "Sin modelo configurado (Ajustes → IA u OPENROUTER_MODEL)",
    };
  }

  let lastDetail = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptMessages: ChatMessage[] =
      attempt === 1
        ? messages
        : [
            ...messages,
            {
              role: "system",
              content:
                "STRICT: tu respuesta anterior no fue JSON válido según el esquema. Responde ÚNICAMENTE el objeto JSON, sin explicaciones ni markdown.",
            },
          ];
    try {
      const raw = await callProvider(
        provider,
        model,
        attemptMessages,
        opts?.timeoutMs
      );
      const extracted = extractJson(raw);
      if (extracted === null) {
        lastDetail = `sin JSON extraíble (raw=${truncate(raw)})`;
        continue;
      }
      const parsed = schema.safeParse(extracted);
      if (!parsed.success) {
        lastDetail = `no cumple el esquema: ${parsed.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join("; ")} (raw=${truncate(raw)})`;
        continue;
      }
      return { ok: true, data: parsed.data, raw };
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      /**
       * O estado da credencial é ditado por QUEM COBRA, não pela UI.
       *
       * Se o provedor disse 401 ou 402 sobre a chave salva em Ajustes → IA,
       * a credencial fica pausada e para-se de tentar: tentar de novo uma
       * chave que o provedor recusa só gasta tempo, e o turno já está
       * perdido. Um 429 ou um 500 NÃO pausam (ver `estadoSegunRespuesta`), então
       * aí sim se tenta de novo. A chave do ambiente não tem linha para
       * pausar: ali se tenta como sempre.
       */
      if (
        err instanceof ProviderHttpError &&
        provider.source === "org" &&
        opts?.organizationId
      ) {
        const pausada = await marcarEstadoPorRespuesta(
          opts.organizationId,
          err.status,
          lastDetail
        ).catch(() => false);
        if (pausada) break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return {
    ok: false,
    error: lastDetail.includes("esquema") || lastDetail.includes("JSON")
      ? "invalid_output"
      : "provider_error",
    detail: lastDetail,
  };
}

function detalleNoConfigurado(estado: Exclude<EstadoIa, { activa: true }>): string {
  switch (estado.motivo) {
    case "sin_configurar":
      return "Sin proveedor de IA: configúralo en Ajustes → IA (u OPENROUTER_API_TOKEN en el entorno)";
    case "token_invalido":
      return `La llave de IA (…${estado.last4}) está pausada: el proveedor la rechazó`;
    case "sin_saldo":
      return `La llave de IA (…${estado.last4}) está pausada: la cuenta no tiene saldo`;
  }
}

async function callProvider(
  provider: AiProvider,
  model: string,
  messages: ChatMessage[],
  timeoutMs = 60_000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(chatCompletionsUrl(provider.baseUrl), {
      method: "POST",
      headers: {
        // O token jamais é logado; só trafega neste header.
        Authorization: `Bearer ${provider.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderHttpError(res.status, text);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("respuesta del proveedor sin contenido");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extração robusta de JSON de uma resposta de modelo:
 * 1) bloco ```json ... ``` (ou ``` ... ```), 2) o texto completo,
 * 3) do primeiro `{` ao último `}`.
 */
export function extractJson(raw: string): unknown | null {
  const candidates: string[] = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(raw.trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // próximo candidato
    }
  }
  return null;
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
