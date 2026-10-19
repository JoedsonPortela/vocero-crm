import type { Channel } from "@/lib/channels";
import { zernioFetch } from "@/server/zernio";

/**
 * 023 — Qual conta da Zernio está sendo conectada, e como está.
 *
 * No painel da Zernio há DOIS ids que parecem iguais: o do **perfil** (o
 * contêiner, que agrupa Instagram, Facebook e TikTok) e o de cada
 * **conta**. Os webhooks roteiam pelo da conta. Quem guardava o do
 * perfil via o webhook responder 200 e cada mensagem descartada em silêncio
 * com «accountId desconhecido».
 *
 * Por isso o id capturado já não se guarda às cegas: resolve-se contra as
 * contas reais dessa chave. De quebra, quem tem uma só conta do canal
 * não precisa copiar nenhum id.
 */

/** Os canais que chegam pela Zernio. */
export type ZernioChannel = Exclude<Channel, "whatsapp">;

/** Como a Zernio chama a plataforma de cada canal. */
export const ZERNIO_PLATFORMS: Record<ZernioChannel, readonly string[]> = {
  instagram: ["instagram"],
  messenger: ["facebook", "messenger"],
  tiktok: ["tiktok"],
};

/** Uma conta de `GET /accounts`, no que interessa ao Vocero. */
export type ZernioAccount = {
  _id: string;
  platform?: string | null;
  username?: string | null;
  displayName?: string | null;
  /** No Instagram, o id com que a Meta identifica o perfil. */
  platformUserId?: string | null;
  isActive?: boolean;
  enabled?: boolean;
  needsReconnection?: boolean;
  platformStatus?: string | null;
  platformStatusReason?: string | null;
  tokenExpiresAt?: string | null;
  messagingRestriction?: unknown;
  /** Só TikTok: `business` ou `personal`. */
  tiktokAccountType?: string | null;
  profileId?: string | { _id?: string } | null;
  metadata?: {
    selectedPageId?: string | null;
    selectedPageName?: string | null;
  } | null;
};

export type ZernioCandidate = { id: string; name: string };

export type PickResult =
  | { ok: true; account: ZernioAccount }
  | {
      ok: false;
      code: "choose_account" | "unknown_account";
      message: string;
      candidates: ZernioCandidate[];
    };

function profileIdOf(a: ZernioAccount): string | null {
  const p = a.profileId;
  if (!p) return null;
  return typeof p === "string" ? p : (p._id ?? null);
}

/** O nome pelo qual uma pessoa reconhece a conta. */
export function zernioAccountName(a: ZernioAccount): string {
  const pagina = a.metadata?.selectedPageName?.trim();
  if (pagina) return pagina;
  const usuario = a.username?.trim().replace(/^@/, "");
  const platform = (a.platform ?? "").toLowerCase();
  if (usuario && platform !== "facebook") return `@${usuario}`;
  return a.displayName?.trim() || usuario || a._id;
}

// Uma agência pode ter dezenas de contas em uma chave: a lista que se mostra a
// quem conecta é cortada, e a mensagem diz isso.
const MAX_CANDIDATES = 8;

/** Puro: decide a conta que corresponde ao capturado (tabela D1 da spec). */
export function pickZernioAccount(
  accounts: readonly ZernioAccount[],
  ref: string | null | undefined,
  channel: ZernioChannel
): PickResult {
  const platforms = ZERNIO_PLATFORMS[channel];
  const delCanal = accounts.filter((a) =>
    platforms.includes((a.platform ?? "").toLowerCase())
  );
  const candidates = delCanal
    .slice(0, MAX_CANDIDATES)
    .map((a) => ({ id: a._id, name: zernioAccountName(a) }));
  const cuales =
    candidates.map((c) => `${c.name} (${c.id})`).join(", ") +
    (delCanal.length > MAX_CANDIDATES ? ` y ${delCanal.length - MAX_CANDIDATES} más` : "");

  if (delCanal.length === 0) {
    return {
      ok: false,
      code: "unknown_account",
      message:
        "Esa llave de Zernio no tiene ninguna cuenta conectada de este canal. Vincúlala en Zernio y vuelve a intentar.",
      candidates,
    };
  }

  const id = ref?.trim() ?? "";
  if (!id) {
    if (delCanal.length === 1) return { ok: true, account: delCanal[0]! };
    return {
      ok: false,
      code: "choose_account",
      message: `Esa llave tiene ${delCanal.length} cuentas de este canal. Elige cuál conectar.`,
      candidates,
    };
  }

  const exacta = accounts.find((a) => a._id === id);
  if (exacta) {
    if (delCanal.includes(exacta)) return { ok: true, account: exacta };
    return {
      ok: false,
      code: "unknown_account",
      message: `Ese id es de una cuenta de ${exacta.platform ?? "otra red"}, no de este canal. Sirven: ${cuales}`,
      candidates,
    };
  }

  // Colou-se o id do PERFIL: vale se nesse perfil houver UMA conta do canal.
  const delPerfil = delCanal.filter((a) => profileIdOf(a) === id);
  if (delPerfil.length === 1) return { ok: true, account: delPerfil[0]! };

  return {
    ok: false,
    code: "unknown_account",
    message: `Ese id no es de ninguna cuenta de este canal en Zernio. Sirven: ${cuales}`,
    candidates,
  };
}

export type Health = { level: "ok" | "warn" | "error"; message: string };

/**
 * Puro: como está a conta segundo a Zernio. `null` é «já não aparece entre as
 * contas dessa chave»: foi desvinculada na Zernio ou a chave é de outra conta.
 */
export function accountHealth(
  account: ZernioAccount | null | undefined,
  channel: ZernioChannel,
  now: Date = new Date()
): Health {
  if (!account) {
    return {
      level: "error",
      message: "La cuenta ya no aparece en Zernio con esa llave. Vuelve a conectarla.",
    };
  }
  if (account.needsReconnection) {
    return { level: "error", message: "Zernio pide reconectar la cuenta." };
  }
  if (account.isActive === false || account.enabled === false) {
    return { level: "error", message: "La cuenta está desactivada en Zernio." };
  }
  if (account.messagingRestriction) {
    return {
      level: "error",
      message: "La plataforma restringió los mensajes de esta cuenta.",
    };
  }
  if (
    channel === "tiktok" &&
    account.tiktokAccountType &&
    account.tiktokAccountType.toLowerCase() !== "business"
  ) {
    return {
      level: "error",
      message:
        "Es una cuenta personal: TikTok solo entrega mensajes de cuentas Business.",
    };
  }
  const estado = account.platformStatus?.toLowerCase();
  if (estado && estado !== "active") {
    const motivo = account.platformStatusReason?.trim();
    return {
      level: "warn",
      message: `La plataforma la reporta como «${account.platformStatus}»${motivo ? `: ${motivo}` : ""}.`,
    };
  }
  const vence = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : NaN;
  if (Number.isFinite(vence) && vence < now.getTime()) {
    return {
      level: "warn",
      message: "El acceso de Zernio a la cuenta venció. Si deja de recibir, reconéctala en Zernio.",
    };
  }
  return { level: "ok", message: "Activa" };
}

/**
 * As contas dessa chave. Lança `MetaApiError` (401 = chave inválida, 0 ou
 * 5xx = a Zernio não responde), igual ao resto do transporte.
 */
export async function fetchZernioAccounts(token: string): Promise<ZernioAccount[]> {
  const json = (await zernioFetch("/accounts", { token, timeoutMs: 10_000 })) as {
    accounts?: ZernioAccount[];
  } | null;
  return Array.isArray(json?.accounts) ? json.accounts : [];
}
