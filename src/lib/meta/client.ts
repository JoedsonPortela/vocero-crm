import { getEnv } from "@/lib/env";

/**
 * Cliente próprio da Graph API da Meta (WhatsApp Cloud API).
 * Única fronteira de saída para a Meta (Constituição II): todo request passa
 * por graphRequest. No self-test, META_GRAPH_BASE_URL aponta para o wa-mock.
 */

export class MetaApiError extends Error {
  status: number;
  code: number | null;
  type: string | null;
  details: unknown;

  constructor(
    message: string,
    opts: { status: number; code?: number | null; type?: string | null; details?: unknown }
  ) {
    super(message);
    this.name = "MetaApiError";
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.type = opts.type ?? null;
    this.details = opts.details;
  }

  /**
   * Token vencido/revogado → a conexão exige nova autenticação.
   * A Meta rotula como "OAuthException" também erros transitórios 5xx
   * (ex. código 2 "service temporarily unavailable"), então o type sozinho
   * NÃO basta: só 401 ou código 190, e jamais com status ≥ 500.
   */
  get isAuthError(): boolean {
    if (this.status >= 500) return false;
    return this.status === 401 || this.code === 190;
  }
}

export async function graphRequest<T>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "DELETE";
    token: string;
    body?: unknown;
  }
): Promise<T> {
  const env = getEnv();
  const url = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Meta", {
      status: 0,
      details: cause,
    });
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON: o texto cru é guardado em details
  }

  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } })
      ?.error;
    throw new MetaApiError(err?.message ?? `Meta respondió ${res.status}`, {
      status: res.status,
      code: err?.code ?? null,
      type: err?.type ?? null,
      details: json ?? text,
    });
  }
  return json as T;
}

/**
 * Normaliza um número para o formato canônico. Números móveis do México chegam
 * da Meta como `521` + 10 dígitos (13 no total); enviar com esse `1` extra
 * produz o erro 131030 — usa-se `52` + 10 dígitos.
 *
 * Desde a identidade resiliente (003) esta normalização é SIMÉTRICA: aplica-se
 * também ao gravar a identidade do contato na ingestão
 * (`wa_identity`), para que `521...` e `52...` resolvam para o mesmo contato.
 */
export function normalizeMx(phone: string): string {
  if (/^521\d{10}$/.test(phone)) {
    return `52${phone.slice(3)}`;
  }
  return phone;
}

/**
 * Troncos que o WhatsApp REPORTA mas que não são usados para ENVIAR, e que a
 * identidade deixa intactos de propósito.
 *
 * Diferentemente do México, aqui a normalização NÃO pode ser simétrica: se a
 * ingestão reescrevesse a identidade, deixaria de coincidir com o `wa_id` que
 * a Meta manda em cada webhook — e com o que um cérebro externo consulta no
 * gateway —, então o contato se partiria em dois. Normaliza-se só o
 * número que trafega pelo cabo.
 *
 * Para adicionar um país: uma linha aqui e o seu caso em
 * `tests/unit/meta-client.test.ts`.
 */
const SEND_ONLY_TRUNKS = [
  // Argentina: a Meta reporta `549` + 10 dígitos; envia-se sem o 9 (issue #35).
  { reported: "549", dialable: "54", nationalDigits: 10 },
] as const;

/**
 * O número como deve ser enviado à Meta.
 *
 * É o que a identidade já canoniza, MAIS os troncos que só atrapalham ao
 * enviar. Cuidado com o alcance real do problema que corrige: o `131030`
 * ("Recipient phone number not in allowed list") vem da lista de
 * destinatários de teste, que só existe ENQUANTO o negócio não está
 * verificado. Já em produção não há lista e a Meta aceita as duas formas —
 * normaliza internamente e responde o `wa_id` com o tronco colocado. Ou seja:
 * isto destrava a colocação em funcionamento, que é justamente quando uma agência está
 * testando a instância e a mensagem de erro a manda revisar uma lista de
 * permitidos que está correta.
 */
export function normalizeRecipient(phone: string): string {
  const canonical = normalizeMx(phone);
  for (const trunk of SEND_ONLY_TRUNKS) {
    const expected = trunk.reported.length + trunk.nationalDigits;
    if (canonical.length === expected && canonical.startsWith(trunk.reported)) {
      return trunk.dialable + canonical.slice(trunk.reported.length);
    }
  }
  return canonical;
}
