import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";

/**
 * 015 — Credenciais do app do Google Cloud do próprio negócio.
 *
 * DOIS segredos criptografados: o client secret e o refresh token que o dono cola
 * uma única vez. Mesmo mecanismo AES-256-GCM dos demais.
 */

export type GoogleCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
  status: "connected" | "error";
};

export async function getGoogleCredentials(
  organizationId: string
): Promise<GoogleCreds | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.googleCredentials)
    .where(scoped(schema.googleCredentials.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientSecret: decryptSecret({
      cipher: row.clientSecretCipher,
      iv: row.clientSecretIv,
      tag: row.clientSecretTag,
    }),
    refreshToken: decryptSecret({
      cipher: row.refreshTokenCipher,
      iv: row.refreshTokenIv,
      tag: row.refreshTokenTag,
    }),
    calendarId: row.calendarId,
    status: row.status,
  };
}

export async function saveGoogleCredentials(input: {
  organizationId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId?: string | null;
}): Promise<void> {
  const db = getDb();
  const secret = encryptSecret(input.clientSecret);
  const refresh = encryptSecret(input.refreshToken);
  const values = {
    clientId: input.clientId,
    clientSecretCipher: secret.cipher,
    clientSecretIv: secret.iv,
    clientSecretTag: secret.tag,
    refreshTokenCipher: refresh.cipher,
    refreshTokenIv: refresh.iv,
    refreshTokenTag: refresh.tag,
    calendarId: input.calendarId?.trim() || "primary",
    status: "connected" as const,
  };
  await db
    .insert(schema.googleCredentials)
    .values({
      id: newId("googleCredentials"),
      organizationId: input.organizationId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [schema.googleCredentials.organizationId],
      set: { ...values, updatedAt: new Date() },
    });
  clearGoogleTokenCache();
}

export async function deleteGoogleCredentials(
  organizationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.googleCredentials)
    .where(scoped(schema.googleCredentials.organizationId, organizationId));
  clearGoogleTokenCache();
}

/** O estado `error` é escrito de verdade (ver zoom-credentials). */
export async function markGoogleError(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.googleCredentials)
    .set({ status: "error", updatedAt: new Date() })
    .where(scoped(schema.googleCredentials.organizationId, organizationId));
}

export function secretLast4(secret: string): string {
  return secret.slice(-4);
}

/* Cache do access token, por processo. O Google os emite por uma hora. */

type CachedToken = { token: string; expiresAtMs: number };

const globalForGoogle = globalThis as unknown as {
  __googleTokens?: Map<string, CachedToken>;
};

function tokenCache(): Map<string, CachedToken> {
  if (!globalForGoogle.__googleTokens) globalForGoogle.__googleTokens = new Map();
  return globalForGoogle.__googleTokens;
}

export function getCachedGoogleToken(key: string): string | null {
  const hit = tokenCache().get(key);
  if (!hit) return null;
  if (hit.expiresAtMs <= Date.now()) {
    tokenCache().delete(key);
    return null;
  }
  return hit.token;
}

export function setCachedGoogleToken(
  key: string,
  token: string,
  expiresInSeconds: number
): void {
  const ttl = Math.max(30, expiresInSeconds - 60) * 1000;
  tokenCache().set(key, { token, expiresAtMs: Date.now() + ttl });
}

export function clearGoogleTokenCache(): void {
  tokenCache().clear();
}
