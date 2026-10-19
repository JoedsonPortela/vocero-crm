import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { columnasDelSecreto, secretoDeLaFila } from "@/server/zernio/secreto-guardado";

/**
 * 022 — Credenciais do canal do TikTok.
 *
 * Uma única fonte: a API unificada da Zernio (sua chave, e o roteamento por
 * `accountRef`). Mesmo contrato das dos demais canais: a chave viaja
 * descriptografada só na memória e nunca sai numa resposta da API — para fora
 * expõe-se só a sua cauda.
 */

export type TiktokCredentials = {
  id: string;
  organizationId: string;
  source: "zernio";
  /** `accountId` da conta do TikTok na Zernio. */
  accountRef: string;
  username: string | null;
  webhookSecret: string | null;
  status: "connected" | "reconnect_required";
  token: string;
};

type Row = typeof schema.tiktokCredentials.$inferSelect;

function toCredentials(row: Row): TiktokCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
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

export async function getTiktokCredentialsByOrg(
  organizationId: string
): Promise<TiktokCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.tiktokCredentials)
    .where(eq(schema.tiktokCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Roteamento do webhook da Zernio: o evento traz `account.id`. */
export async function getTiktokCredentialsByAccountRef(
  accountRef: string
): Promise<TiktokCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.tiktokCredentials)
    .where(eq(schema.tiktokCredentials.accountRef, accountRef))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveTiktokCredentials(input: {
  organizationId: string;
  accountRef: string;
  username: string | null;
  token: string;
  webhookSecret: string | null;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.token);
  const existing = await getTiktokCredentialsByOrg(input.organizationId);

  const values = {
    organizationId: input.organizationId,
    source: "zernio" as const,
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
      .update(schema.tiktokCredentials)
      .set(values)
      .where(eq(schema.tiktokCredentials.id, existing.id));
    return;
  }
  await db
    .insert(schema.tiktokCredentials)
    .values({ id: newId("credentials"), ...values });
}

/** A chave morreu: os envios são pausados e a UI pede para reconectar. */
export async function markTiktokReconnectRequired(
  organizationId: string
): Promise<void> {
  await getDb()
    .update(schema.tiktokCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(eq(schema.tiktokCredentials.organizationId, organizationId));
}

export function tokenLast4(token: string): string {
  return token.slice(-4);
}
