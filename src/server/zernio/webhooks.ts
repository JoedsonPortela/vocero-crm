import { createHash } from "node:crypto";
import { zernioFetch } from "@/server/zernio";
import type { Health } from "@/server/zernio/cuentas";

/**
 * 023 — Os webhooks da Zernio que entregam a esta instância.
 *
 * A Zernio guarda a verdade de duas coisas que antes eram capturadas à mão e
 * capturadas mal: com qual segredo assina, e se o webhook existe, está ativo e
 * cobre a conta. Aqui são lidos com a chave já guardada.
 *
 * Um webhook «aponta para cá» se a sua URL leva o segmento secreto desta
 * instância. Os demais webhooks dessa chave (outro CRM, outra ferramenta do
 * negócio) não são usados para nada e jamais são modificados.
 */

/** O evento com o qual chega uma mensagem de um cliente. */
export const ZERNIO_MESSAGE_EVENT = "message.received";

/** Um webhook de `GET /webhooks/settings`, no que interessa ao Vocero. */
export type ZernioWebhook = {
  _id: string;
  name?: string | null;
  url?: string | null;
  secret?: string | null;
  events?: string[] | null;
  isActive?: boolean;
  /** Vazio = todas as contas dessa chave. */
  accountIds?: string[] | null;
  failureCount?: number | null;
  lastFiredAt?: string | null;
};

/** Quanto vale uma leitura boa, e quanto tempo se lembra uma falha. */
export const WEBHOOKS_OK_MS = 10 * 60 * 1000;
export const WEBHOOKS_FAIL_MS = 60 * 1000;
/**
 * Quando uma assinatura não coincide com o lido, relê-se se a leitura tiver mais
 * que isto: é o que o CRM demora para perceber que o segredo mudou na
 * Zernio, e também o teto de consultas que alguém pode provocar enviando
 * assinaturas inválidas (uma por minuto e por chave).
 */
export const WEBHOOKS_RECHECK_MS = 60 * 1000;

type Entry = { at: number; ok: boolean; webhooks: ZernioWebhook[] };

// Em globalThis porque o Next recarrega módulos em desenvolvimento; uma instância é um
// processo, então a memória basta. A chave nunca é a do mapa: o seu hash.
const g = globalThis as unknown as { __voceroZernioWebhooks?: Map<string, Entry> };
function cache(): Map<string, Entry> {
  if (!g.__voceroZernioWebhooks) g.__voceroZernioWebhooks = new Map();
  return g.__voceroZernioWebhooks;
}
const keyOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Os webhooks dessa chave, sem cache. Lança `MetaApiError` se a Zernio falhar. */
export async function fetchZernioWebhooks(token: string): Promise<ZernioWebhook[]> {
  const json = (await zernioFetch("/webhooks/settings", { token, timeoutMs: 5000 })) as {
    webhooks?: ZernioWebhook[];
  } | null;
  const webhooks = Array.isArray(json?.webhooks) ? json.webhooks : [];
  cache().set(keyOf(token), { at: Date.now(), ok: true, webhooks });
  return webhooks;
}

/**
 * O mesmo, com cache e sem lançar: é o que usa a verificação de assinatura,
 * que roda em cada entrega. Uma falha é lembrada por um minuto para que uma
 * rajada de entregas com a Zernio fora não se converta em uma rajada de
 * consultas; a última leitura boa segue sendo usada enquanto isso.
 *
 * `maxAgeMs` pede uma leitura mais fresca que a padrão (só encurta a vida de
 * uma leitura boa; uma falha continua sendo lembrada pelo seu minuto).
 */
export async function cachedZernioWebhooks(
  token: string,
  maxAgeMs: number = WEBHOOKS_OK_MS
): Promise<{ ok: boolean; webhooks: ZernioWebhook[] }> {
  const key = keyOf(token);
  const hit = cache().get(key);
  const vida = hit?.ok ? Math.min(WEBHOOKS_OK_MS, maxAgeMs) : WEBHOOKS_FAIL_MS;
  if (hit && Date.now() - hit.at < vida) {
    return { ok: hit.ok, webhooks: hit.webhooks };
  }
  try {
    return { ok: true, webhooks: await fetchZernioWebhooks(token) };
  } catch {
    const webhooks = hit?.webhooks ?? [];
    cache().set(key, { at: Date.now(), ok: false, webhooks });
    return { ok: false, webhooks };
  }
}

export function forgetZernioWebhooks(token: string): void {
  cache().delete(keyOf(token));
}

/** Puro: a URL desse webhook leva o segmento secreto desta instância? */
export function pointsHere(webhook: ZernioWebhook, segment: string): boolean {
  if (!segment || typeof webhook.url !== "string") return false;
  try {
    return new URL(webhook.url).pathname.split("/").includes(segment);
  } catch {
    return false;
  }
}

/** Puro: ativo, com o evento de mensagens e com essa conta dentro do seu limite. */
export function coversAccount(webhook: ZernioWebhook, accountId: string): boolean {
  if (webhook.isActive === false) return false;
  const events = webhook.events ?? [];
  if (events.length > 0 && !events.includes(ZERNIO_MESSAGE_EVENT)) return false;
  const accounts = webhook.accountIds ?? [];
  return accounts.length === 0 || accounts.includes(accountId);
}

/** Os segredos com que a Zernio assina o que entrega a esta instância. */
export async function webhookSecretsFromZernio(
  token: string,
  segment: string,
  maxAgeMs?: number
): Promise<string[]> {
  const { webhooks } = await cachedZernioWebhooks(token, maxAgeMs);
  return webhooks
    .filter((w) => pointsHere(w, segment))
    .map((w) => w.secret)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

export type WebhookHealth = Health & {
  lastFiredAt: string | null;
  failureCount: number;
};

/** Puro: como está o webhook para uma conta específica. */
export function webhookHealth(
  webhooks: readonly ZernioWebhook[],
  segment: string,
  accountId: string
): WebhookHealth {
  const aqui = webhooks.filter((w) => pointsHere(w, segment));
  const nada = { lastFiredAt: null, failureCount: 0 };
  if (aqui.length === 0) {
    return {
      level: "error",
      message: "Zernio no tiene un webhook hacia esta instancia: los mensajes no llegan.",
      ...nada,
    };
  }
  const activos = aqui.filter((w) => w.isActive !== false);
  if (activos.length === 0) {
    return {
      level: "error",
      message: "El webhook hacia esta instancia está desactivado en Zernio.",
      ...nada,
    };
  }
  const cubre = activos.find((w) => coversAccount(w, accountId));
  if (!cubre) {
    const sinEvento = activos.some(
      (w) => (w.events ?? []).length > 0 && !(w.events ?? []).includes(ZERNIO_MESSAGE_EVENT)
    );
    return {
      level: "error",
      message: sinEvento
        ? `El webhook no está suscrito a «${ZERNIO_MESSAGE_EVENT}».`
        : "El webhook no incluye esta cuenta: sus mensajes no llegan.",
      ...nada,
    };
  }
  const failureCount = cubre.failureCount ?? 0;
  const lastFiredAt = cubre.lastFiredAt ?? null;
  if (failureCount > 0) {
    return {
      level: "warn",
      message: `Zernio registra ${failureCount} ${failureCount === 1 ? "entrega fallida" : "entregas fallidas"} seguidas.`,
      lastFiredAt,
      failureCount,
    };
  }
  return { level: "ok", message: "Activo", lastFiredAt, failureCount };
}

/**
 * Deixa UM webhook dessa chave apontando para cá, com o evento de mensagens, o
 * segredo informado e limitado a essas contas. Se já houver um que aponte para cá (ou que
 * leve o nome desta instância, que é o que sobra quando se rotacionou o
 * segmento secreto), atualiza-se em vez de criar outro.
 *
 * O limite de contas não é um detalhe: um webhook sem ele recebe as mensagens
 * de TODAS as contas da chave, e a chave de uma agência enxerga as de seus
 * clientes.
 */
export async function ensureZernioWebhook(input: {
  token: string;
  segment: string;
  name: string;
  url: string;
  /** Mantém a URL do webhook existente se for uma destas. */
  acceptableUrls: readonly string[];
  accountIds: readonly string[];
  secret: string;
}): Promise<{ created: boolean; id: string }> {
  const existentes = await fetchZernioWebhooks(input.token);
  const previo =
    existentes.find((w) => pointsHere(w, input.segment) && w.isActive !== false) ??
    existentes.find((w) => pointsHere(w, input.segment)) ??
    existentes.find((w) => w.name === input.name);

  const url =
    previo?.url && input.acceptableUrls.includes(previo.url) ? previo.url : input.url;
  const body = {
    name: previo?.name || input.name,
    url,
    events: [ZERNIO_MESSAGE_EVENT],
    secret: input.secret,
    isActive: true,
    accountIds: [...new Set(input.accountIds)],
  };

  const json = (await zernioFetch("/webhooks/settings", {
    method: previo ? "PUT" : "POST",
    token: input.token,
    body: previo ? { webhookId: previo._id, ...body } : body,
    timeoutMs: 10_000,
  })) as { webhook?: { _id?: string } } | null;
  forgetZernioWebhooks(input.token);

  const id = json?.webhook?._id ?? previo?._id;
  if (!id) throw new Error("Zernio respondió sin el webhook");
  return { created: !previo, id };
}
