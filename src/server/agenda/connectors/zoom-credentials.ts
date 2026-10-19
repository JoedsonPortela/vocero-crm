import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";

/**
 * 015 — Credenciais do app Server-to-Server do Zoom do próprio negócio.
 *
 * Mesmo mecanismo de criptografia do token do WhatsApp: um segundo mecanismo
 * seria um segundo mecanismo para auditar. Para fora só saem os últimos 4
 * do segredo.
 */

export type ZoomCreds = {
  accountId: string;
  clientId: string;
  clientSecret: string;
  status: "connected" | "error";
};

export async function getZoomCredentials(
  organizationId: string
): Promise<ZoomCreds | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.zoomCredentials)
    .where(scoped(schema.zoomCredentials.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    accountId: row.accountId,
    clientId: row.clientId,
    clientSecret: decryptSecret({
      cipher: row.secretCipher,
      iv: row.secretIv,
      tag: row.secretTag,
    }),
    status: row.status,
  };
}

export async function saveZoomCredentials(input: {
  organizationId: string;
  accountId: string;
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.clientSecret);
  const values = {
    accountId: input.accountId,
    clientId: input.clientId,
    secretCipher: enc.cipher,
    secretIv: enc.iv,
    secretTag: enc.tag,
    status: "connected" as const,
  };
  await db
    .insert(schema.zoomCredentials)
    .values({
      id: newId("zoomCredentials"),
      organizationId: input.organizationId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [schema.zoomCredentials.organizationId],
      set: { ...values, updatedAt: new Date() },
    });
  // O token em cache foi emitido com as credenciais antigas.
  clearZoomTokenCache();
}

export async function deleteZoomCredentials(
  organizationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.zoomCredentials)
    .where(scoped(schema.zoomCredentials.organizationId, organizationId));
  clearZoomTokenCache();
}

/**
 * Marca a conexão como quebrada. É ESCRITO de verdade, no momento em que o
 * provedor rejeita a autenticação: se ninguém o escrevesse, o dono
 * ficaria sabendo pelo cliente que não recebeu seu link.
 */
export async function markZoomError(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.zoomCredentials)
    .set({ status: "error", updatedAt: new Date() })
    .where(scoped(schema.zoomCredentials.organizationId, organizationId));
}

/** Últimos 4 do segredo, para a UI. Jamais o segredo. */
export function secretLast4(secret: string): string {
  return secret.slice(-4);
}

/* --------------------------------------------------------------------------
 * Cache do token de acesso, por processo.
 *
 * O Zoom emite um token de vida curta a cada chamada ao endpoint de OAuth;
 * pedir um novo em cada agendamento é uma chamada de rede a mais e um limite de taxa
 * que se aproxima. Renova-se 60 s antes de expirar, e se invalida ao trocar ou
 * apagar as credenciais.
 * ------------------------------------------------------------------------ */

type CachedToken = { token: string; expiresAtMs: number };

const globalForZoom = globalThis as unknown as {
  __zoomTokens?: Map<string, CachedToken>;
};

function tokenCache(): Map<string, CachedToken> {
  if (!globalForZoom.__zoomTokens) globalForZoom.__zoomTokens = new Map();
  return globalForZoom.__zoomTokens;
}

export function getCachedZoomToken(key: string): string | null {
  const hit = tokenCache().get(key);
  if (!hit) return null;
  if (hit.expiresAtMs <= Date.now()) {
    tokenCache().delete(key);
    return null;
  }
  return hit.token;
}

export function setCachedZoomToken(
  key: string,
  token: string,
  expiresInSeconds: number
): void {
  const ttl = Math.max(30, expiresInSeconds - 60) * 1000;
  tokenCache().set(key, { token, expiresAtMs: Date.now() + ttl });
}

export function clearZoomTokenCache(): void {
  tokenCache().clear();
}
