import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { columnasDelSecreto, secretoDeLaFila } from "@/server/zernio/secreto-guardado";

/**
 * 014 — Credenciais do canal do Instagram.
 *
 * Mesmo contrato das do WhatsApp (`server/whatsapp/credentials.ts`): o
 * token viaja descriptografado só na memória e nunca sai numa resposta da
 * API — para fora expõe-se somente a sua cauda.
 */

export type InstagramCredentials = {
  id: string;
  organizationId: string;
  source: "zernio" | "meta";
  igUserId: string;
  accountRef: string | null;
  username: string | null;
  webhookSecret: string | null;
  status: "connected" | "reconnect_required";
  token: string;
};

type Row = typeof schema.instagramCredentials.$inferSelect;

function toCredentials(row: Row): InstagramCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    igUserId: row.igUserId,
    accountRef: row.accountRef,
    username: row.username,
    webhookSecret: secretoDeLaFila(row),
    status: row.status,
    token: decryptSecret({
      cipher: row.tokenCipher,
      iv: row.tokenIv,
      tag: row.tokenTag,
    }),
  };
}

export async function getInstagramCredentialsByOrg(
  organizationId: string
): Promise<InstagramCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.instagramCredentials)
    .where(eq(schema.instagramCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Roteamento do webhook da Meta: `entry[].id` é o IG_ID do perfil. */
export async function getInstagramCredentialsByIgUserId(
  igUserId: string
): Promise<InstagramCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.instagramCredentials)
    .where(eq(schema.instagramCredentials.igUserId, igUserId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Roteamento do webhook da Zernio: o evento traz `account.id`, não o perfil. */
export async function getInstagramCredentialsByAccountRef(
  accountRef: string
): Promise<InstagramCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.instagramCredentials)
    .where(eq(schema.instagramCredentials.accountRef, accountRef))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveInstagramCredentials(input: {
  organizationId: string;
  source: "zernio" | "meta";
  igUserId: string;
  accountRef: string | null;
  username: string | null;
  token: string;
  webhookSecret: string | null;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.token);
  const existing = await getInstagramCredentialsByOrg(input.organizationId);

  const values = {
    organizationId: input.organizationId,
    source: input.source,
    igUserId: input.igUserId,
    accountRef: input.accountRef,
    username: input.username,
    tokenCipher: enc.cipher,
    tokenIv: enc.iv,
    tokenTag: enc.tag,
    ...columnasDelSecreto(input.webhookSecret),
    status: "connected" as const,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(schema.instagramCredentials)
      .set(values)
      .where(eq(schema.instagramCredentials.id, existing.id));
    return;
  }
  await db
    .insert(schema.instagramCredentials)
    .values({ id: newId("credentials"), ...values });
}

/** O token morreu: os envios são pausados e a UI pede para reconectar. */
export async function markInstagramReconnectRequired(
  organizationId: string
): Promise<void> {
  await getDb()
    .update(schema.instagramCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(eq(schema.instagramCredentials.organizationId, organizationId));
}

export function tokenLast4(token: string): string {
  return token.slice(-4);
}
