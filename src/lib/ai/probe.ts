import { chatCompletionsUrl, modelsUrl } from "@/lib/ai/presets";

/**
 * Sonda do provedor para Ajustes → IA: «Probar conexión» e «Traer modelos».
 *
 * Vive em `lib/ai` porque é a única fronteira com o LLM (Constituição II).
 * Nunca lança exceção: toda falha volta tipada, com o código HTTP quando houve,
 * para que a tela diga O QUE aconteceu («llave rechazada», «sin saldo», «ese
 * modelo no existe») em vez de «error». E nada é salvo daqui: testar
 * é testar.
 */

export type ProbeErrorCode =
  | "invalid_token"
  | "no_credit"
  | "model_not_found"
  | "rate_limited"
  | "provider_error"
  | "unreachable"
  | "timeout"
  | "bad_url";

export type ProbeResult =
  | { ok: true; latencyMs: number }
  | {
      ok: false;
      code: ProbeErrorCode;
      httpStatus: number | null;
      message: string;
    };

const PROBE_TIMEOUT_MS = 20_000;
const MAX_BODY = 2000;

/** Uma chamada mínima: um turno de poucos tokens com o modelo escolhido. */
export async function probeProvider(input: {
  baseUrl: string;
  model: string;
  token: string;
  timeoutMs?: number;
  /** Somente para testes. */
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  let url: string;
  try {
    url = chatCompletionsUrl(input.baseUrl);
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("protocolo");
    }
  } catch {
    return {
      ok: false,
      code: "bad_url",
      httpStatus: null,
      message: "A base URL não é um endereço http(s) válido",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? PROBE_TIMEOUT_MS
  );
  const inicio = Date.now();
  try {
    const res = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        // O token jamais é logado; só trafega neste header.
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "Responde solo: ok" }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    });
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
      } | null;
      if (!json?.choices?.length) {
        return {
          ok: false,
          code: "provider_error",
          httpStatus: res.status,
          message:
            "El proveedor contestó, pero no con el formato de la API de OpenAI (sin `choices`)",
        };
      }
      return { ok: true, latencyMs: Date.now() - inicio };
    }
    const text = await res.text().catch(() => "");
    return clasificarFallo(res.status, text);
  } catch {
    return controller.signal.aborted
      ? {
          ok: false,
          code: "timeout",
          httpStatus: null,
          message: "O provedor não respondeu a tempo",
        }
      : {
          ok: false,
          code: "unreachable",
          httpStatus: null,
          message:
            "No se pudo conectar con el proveedor: revisa la base URL y la red del servidor",
        };
  } finally {
    clearTimeout(timer);
  }
}

/** O que significa um código do provedor, na linguagem do dono. */
export function clasificarFallo(
  status: number,
  body: string
): Extract<ProbeResult, { ok: false }> {
  const detalle = resumenDelCuerpo(body);
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: "invalid_token",
      httpStatus: status,
      message: `El proveedor rechazó la llave (${status})${detalle}`,
    };
  }
  if (status === 402) {
    return {
      ok: false,
      code: "no_credit",
      httpStatus: status,
      message: `La cuenta no tiene saldo (402)${detalle}`,
    };
  }
  if (status === 404 || (status === 400 && /model/i.test(body))) {
    return {
      ok: false,
      code: "model_not_found",
      httpStatus: status,
      message: `El proveedor no reconoce ese modelo (${status})${detalle}`,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: "rate_limited",
      httpStatus: status,
      message: `El proveedor pide esperar (429): la llave sirve, vuelve a probar en un momento${detalle}`,
    };
  }
  return {
    ok: false,
    code: "provider_error",
    httpStatus: status,
    message: `El proveedor respondió ${status}${detalle}`,
  };
}

/** O `error.message` do corpo, se vier, truncado; se não, nada. */
function resumenDelCuerpo(body: string): string {
  if (!body) return "";
  let texto = body;
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (typeof json?.error === "string") texto = json.error;
    else if (typeof json?.error?.message === "string") texto = json.error.message;
  } catch {
    // não era JSON: usa-se o texto como está
  }
  texto = texto.replace(/\s+/g, " ").trim();
  if (!texto) return "";
  return `: ${texto.length > MAX_BODY ? `${texto.slice(0, MAX_BODY)}…` : texto}`;
}

export type ModelsResult =
  | { ok: true; modelos: { id: string; nombre: string | null }[] }
  | {
      ok: false;
      code: "unsupported" | "invalid_token" | "unreachable" | "timeout" | "bad_url" | "provider_error";
      httpStatus: number | null;
      message: string;
    };

const MAX_MODELS = 1000;

/**
 * `GET {base}/v1/models` com a chave. OpenRouter e OpenAI o publicam com a
 * mesma forma (`{ data: [{ id, name? }] }`); um provedor que não o tenha
 * responde 404 ou algo que não é essa lista, e aqui isso é dito sem quebrar: o
 * modelo pode ser digitado à mão.
 */
export async function listModels(input: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Somente para testes. */
  fetchImpl?: typeof fetch;
}): Promise<ModelsResult> {
  let url: string;
  try {
    url = modelsUrl(input.baseUrl);
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("protocolo");
    }
  } catch {
    return {
      ok: false,
      code: "bad_url",
      httpStatus: null,
      message: "A base URL não é um endereço http(s) válido",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? PROBE_TIMEOUT_MS
  );
  try {
    const res = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        code: "invalid_token",
        httpStatus: res.status,
        message: `El proveedor rechazó la llave (${res.status})`,
      };
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return noSoportado(res.status);
    }
    if (!res.ok) {
      return {
        ok: false,
        code: "provider_error",
        httpStatus: res.status,
        message: `El proveedor respondió ${res.status} al pedir la lista de modelos`,
      };
    }
    const json = (await res.json().catch(() => null)) as {
      data?: unknown;
    } | null;
    if (!json || !Array.isArray(json.data)) return noSoportado(res.status);
    const modelos = json.data
      .map((m) => {
        if (!m || typeof m !== "object") return null;
        const r = m as { id?: unknown; name?: unknown };
        if (typeof r.id !== "string" || !r.id.trim()) return null;
        return {
          id: r.id.trim(),
          nombre: typeof r.name === "string" && r.name.trim() ? r.name.trim() : null,
        };
      })
      .filter((m): m is { id: string; nombre: string | null } => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, MAX_MODELS);
    return { ok: true, modelos };
  } catch {
    return controller.signal.aborted
      ? {
          ok: false,
          code: "timeout",
          httpStatus: null,
          message: "O provedor não respondeu a tempo",
        }
      : {
          ok: false,
          code: "unreachable",
          httpStatus: null,
          message:
            "No se pudo conectar con el proveedor: revisa la base URL y la red del servidor",
        };
  } finally {
    clearTimeout(timer);
  }
}

function noSoportado(status: number): Extract<ModelsResult, { ok: false }> {
  return {
    ok: false,
    code: "unsupported",
    httpStatus: status,
    message:
      "Este proveedor no publica su lista de modelos: escribe el nombre del modelo a mano",
  };
}
