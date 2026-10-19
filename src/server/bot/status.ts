import {
  BRAIN_MODES,
  SIN_DESPACHO,
  type BrainDispatchDto,
  type BrainHealthDto,
  type BrainMode,
  type BrainRelayDto,
  type BrainStatusDto,
  type BrainWarning,
} from "@/lib/brain-status";

/**
 * «Quem responde aos seus clientes»: qual cérebro responde os WhatsApp da
 * instância e se há dois respondendo ao mesmo tempo.
 *
 * O agente incluído só responde com token de IA E o interruptor do
 * Agente ligado. Um cérebro externo (Nea) não olha esse interruptor — nem
 * recebe: `/api/bot/profile` não o envia —, então com os dois ativos o
 * cliente recebe duas respostas diferentes. O CRM não sabe da Nea mais que duas
 * coisas: quando chamou pela última vez `/api/bot/*` e, se foi configurado
 * `BRAIN_HEALTH_URL`, o que diz o seu `/health`.
 *
 * 021 — Com o despacho ativo (`BRAIN_DISPATCH_URL`) não é preciso adivinhar:
 * o CRM empurra cada turno para o cérebro e cala o agente incluído, então
 * a dupla resposta não pode sair daqui.
 */

/** Uma chamada a `/api/bot/*` nesta janela conta como «está respondendo». */
export const EXTERNAL_SEEN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** O `/health` é perguntado a partir do servidor e não pode travar o cartão. */
export const BRAIN_HEALTH_TIMEOUT_MS = 2000;
/** Por quanto tempo uma resposta é reutilizada: o cartão se atualiza sozinho e o painel
 *  de contato a pede a cada evento da caixa de entrada. */
export const BRAIN_HEALTH_TTL_MS = 15_000;
/** Um `/health` são umas centenas de bytes; mais que isso não é um `/health`. */
const MAX_HEALTH_BYTES = 64 * 1024;

type HealthCacheEntry = {
  url: string;
  expiresAt: number;
  pending: Promise<BrainHealthDto>;
};

// Em globalThis: os módulos podem ser avaliados mais de uma vez (uma por rota em
// dev) e a última chamada é anotada por `requireBotKey`, em outra rota.
const globalForBrain = globalThis as unknown as {
  __voceroBotLastSeen?: number;
  __voceroBrainHealth?: HealthCacheEntry;
};

/** Quem anota é `requireBotKey` em cada chamada autenticada. Só memória: se
 *  perde ao reiniciar, e a UI diz isso («desde o último arranque»). */
export function markBotSeen(now: number = Date.now()): void {
  globalForBrain.__voceroBotLastSeen = now;
}

export function botLastSeenAt(): Date | null {
  const t = globalForBrain.__voceroBotLastSeen;
  return typeof t === "number" ? new Date(t) : null;
}

/** Só para testes. */
export function resetBrainStatusState(): void {
  delete globalForBrain.__voceroBotLastSeen;
  delete globalForBrain.__voceroBrainHealth;
}

// ---------------------------------------------------------------------------
// O cálculo (puro)
// ---------------------------------------------------------------------------

export type BrainStatusInput = {
  aiConfigured: boolean;
  agentEnabled: boolean;
  botKeyConfigured: boolean;
  lastSeenAt: Date | null;
  health: BrainHealthDto | null;
  /** 021. Opcional: sem ele, uma instância que não despacha. */
  dispatch?: BrainDispatchDto;
  now: Date;
};

export function computeBrainStatus(input: BrainStatusInput): BrainStatusDto {
  const dispatch = input.dispatch ?? SIN_DESPACHO;
  // O despacho ativo cala o agente incluído (`server/ai/trigger.ts`):
  // mesmo que tenha IA e interruptor, não é ele quem responde.
  const wouldAnswer = input.aiConfigured && input.agentEnabled;
  const answering = wouldAnswer && !dispatch.active;
  const seenRecently =
    input.botKeyConfigured &&
    input.lastSeenAt !== null &&
    input.now.getTime() - input.lastSeenAt.getTime() <= EXTERNAL_SEEN_WINDOW_MS;
  const active =
    seenRecently || input.health?.reachable === true || dispatch.active;

  let warning: BrainWarning | null = null;
  if (answering && active) warning = "doble_respuesta";
  // Ninguém pode responder: sem agente incluído e com /api/bot/* fechada (sem
  // chave, um Nea online também não pode falar pelo CRM).
  else if (!answering && !input.botKeyConfigured) warning = "sin_cerebro";

  return {
    embedded: {
      configured: input.aiConfigured,
      enabled: input.agentEnabled,
      answering,
      silenced: wouldAnswer && dispatch.active,
    },
    external: {
      keyConfigured: input.botKeyConfigured,
      lastSeenAt: input.lastSeenAt?.toISOString() ?? null,
      active,
      health: input.health,
    },
    dispatch,
    warning,
  };
}

// ---------------------------------------------------------------------------
// O /health do cérebro externo
// ---------------------------------------------------------------------------

export type FetchBrainHealthOptions = {
  timeoutMs?: number;
  /** Só para testes. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * Pergunta ao `/health` do cérebro externo. Nunca lança: qualquer falha é
 * `reachable: false` com seu motivo, em 2 s no máximo. Uma URL que não é
 * http(s) nem se tenta: `problem: "config"`.
 *
 * - Não segue redirecionamentos: o `/health` de um serviço interno não redireciona,
 *   e segui-lo seria pedir ao servidor que chame outro destino.
 * - As credenciais da URL (`http://user:pass@nea:8000/health`) viajam
 *   como `Authorization: Basic` —o fetch rejeita uma URL que as traz— e, como
 *   a rota e a query, jamais saem na resposta: só o host.
 * - Tolera qualquer subconjunto de campos (uma Nea antiga só manda
 *   `status`): o mínimo é 200 com `ok: true` ou `status: "ok"`.
 */
export async function fetchBrainHealth(
  rawUrl: string,
  opts: FetchBrainHealthOptions = {}
): Promise<BrainHealthDto> {
  const checkedAt = (opts.now?.() ?? new Date()).toISOString();
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return { reachable: false, host: "", checkedAt, problem: "config" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { reachable: false, host: "", checkedAt, problem: "config" };
  }
  const base = { host: target.host, checkedAt };

  const headers: Record<string, string> = { accept: "application/json" };
  if (target.username || target.password) {
    const user = decodeURIComponent(target.username);
    const pass = decodeURIComponent(target.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    target.username = "";
    target.password = "";
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? BRAIN_HEALTH_TIMEOUT_MS
  );
  try {
    const res = await (opts.fetchImpl ?? fetch)(target, {
      method: "GET",
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    // O Node devolve o 3xx tal como está; um navegador, um `opaqueredirect`.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      return {
        ...base,
        reachable: false,
        problem: "redirect",
        ...(res.status ? { httpStatus: res.status } : {}),
      };
    }
    const body = parseJsonObject(await readCapped(res, MAX_HEALTH_BYTES));
    // A identidade sai mesmo que não esteja saudável: a Nea a manda também no seu 503.
    const identity = body ? parseIdentity(body) : {};
    if (res.status !== 200) {
      return { ...base, ...identity, reachable: false, problem: "status", httpStatus: res.status };
    }
    if (!body || !(body.ok === true || body.status === "ok")) {
      return { ...base, ...identity, reachable: false, problem: "invalid" };
    }
    return { ...base, ...identity, reachable: true };
  } catch {
    return {
      ...base,
      reachable: false,
      problem: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetchBrainHealth` com cache de 15 s por URL, compartilhado entre chamadas
 * simultâneas: o cartão e o painel de contato não martelam a Nea.
 * `null` se não houver URL configurada.
 */
export async function getBrainHealth(
  rawUrl: string | undefined,
  opts: FetchBrainHealthOptions & { ttlMs?: number; clock?: () => number } = {}
): Promise<BrainHealthDto | null> {
  if (!rawUrl) return null;
  const clock = opts.clock ?? Date.now;
  const cached = globalForBrain.__voceroBrainHealth;
  if (cached && cached.url === rawUrl && clock() < cached.expiresAt) {
    return cached.pending;
  }
  const entry: HealthCacheEntry = {
    url: rawUrl,
    // Em voo não expira: quem chegar nesse meio-tempo espera a mesma.
    expiresAt: Number.POSITIVE_INFINITY,
    pending: fetchBrainHealth(rawUrl, opts),
  };
  globalForBrain.__voceroBrainHealth = entry;
  const result = await entry.pending;
  entry.expiresAt = clock() + (opts.ttlMs ?? BRAIN_HEALTH_TTL_MS);
  return result;
}

// ---------------------------------------------------------------------------
// Leitura defensiva
// ---------------------------------------------------------------------------

/** O corpo como texto, ou `null` se exceder o limite. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type Identity = Pick<
  BrainHealthDto,
  "version" | "commit" | "commitVerified" | "mode" | "relay"
>;

function parseIdentity(body: Record<string, unknown>): Identity {
  const out: Identity = {};
  const version = shortText(body.version, 40);
  if (version) out.version = version;
  if (typeof body.commit === "string" && /^[0-9a-f]{4,40}$/i.test(body.commit)) {
    out.commit = body.commit;
  }
  if (typeof body.commitVerified === "boolean") {
    out.commitVerified = body.commitVerified;
  }
  const mode = parseMode(body.mode);
  if (mode) out.mode = mode;
  const relay = parseRelay(body.relay);
  if (relay) out.relay = relay;
  return out;
}

function shortText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length === 0 || t.length > max) return undefined;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 32 || c === 127) return undefined; // caracteres de controle
  }
  return t;
}

function parseMode(v: unknown): BrainMode | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.trim().toLowerCase().normalize("NFC");
  const normalized = m === "estandar" ? "estándar" : m;
  return (BRAIN_MODES as readonly string[]).includes(normalized)
    ? (normalized as BrainMode)
    : undefined;
}

function parseRelay(v: unknown): BrainRelayDto | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const pendientes = nonNegative(r.pendientes, true);
  const masViejoSegundos = nonNegative(r.masViejoSegundos, false);
  const ultimoErrorEn = isoOrNull(r.ultimoErrorEn);
  if (pendientes === null && masViejoSegundos === null && ultimoErrorEn === null) {
    return undefined;
  }
  return { pendientes, masViejoSegundos, ultimoErrorEn };
}

function nonNegative(v: unknown, integer: boolean): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return integer ? Math.floor(v) : v;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
