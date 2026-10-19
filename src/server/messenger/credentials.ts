import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { columnasDelSecreto, secretoDeLaFila } from "@/server/zernio/secreto-guardado";

/**
 * 017 — Credenciais do canal do Messenger.
 *
 * Duas fontes, como no Instagram: a API unificada da Zernio (uma chave, e o
 * roteamento por `accountRef`) ou um app próprio da Meta (token da página, e
 * o roteamento por `pageId`). O token viaja descriptografado só na memória e nunca
 * sai numa resposta da API — para fora expõe-se a sua cauda.
 */

export type MessengerCredentials = {
  id: string;
  organizationId: string;
  source: "zernio" | "meta";
  /** ID da página do Facebook. No modo Zernio pode não ser conhecido. */
  pageId: string | null;
  pageName: string | null;
  /** Zernio: accountId da conta conectada. Meta direto: null. */
  accountRef: string | null;
  webhookSecret: string | null;
  status: "connected" | "reconnect_required";
  token: string;
};

type Row = typeof schema.messengerCredentials.$inferSelect;

function toCredentials(row: Row): MessengerCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    pageId: row.pageId,
    pageName: row.pageName,
    accountRef: row.accountRef,
    webhookSecret: secretoDeLaFila(row),
    status: row.status,
    token: decryptSecret({
      cipher: row.tokenCipher,
      iv: row.tokenIv,
      tag: row.tokenTag,
    }),
  };
}

export async function getMessengerCredentialsByOrg(
  organizationId: string
): Promise<MessengerCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.messengerCredentials)
    .where(eq(schema.messengerCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Roteamento do webhook da Meta: `entry[].id` é o ID da página. */
export async function getMessengerCredentialsByPageId(
  pageId: string
): Promise<MessengerCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.messengerCredentials)
    .where(eq(schema.messengerCredentials.pageId, pageId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Roteamento do webhook da Zernio: o evento traz `account.id`, não a página. */
export async function getMessengerCredentialsByAccountRef(
  accountRef: string
): Promise<MessengerCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.messengerCredentials)
    .where(eq(schema.messengerCredentials.accountRef, accountRef))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveMessengerCredentials(input: {
  organizationId: string;
  source: "zernio" | "meta";
  pageId: string | null;
  pageName: string | null;
  accountRef: string | null;
  token: string;
  webhookSecret: string | null;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.token);
  const existing = await getMessengerCredentialsByOrg(input.organizationId);

  const values = {
    organizationId: input.organizationId,
    source: input.source,
    pageId: input.pageId,
    pageName: input.pageName,
    accountRef: input.accountRef,
    tokenCipher: enc.cipher,
    tokenIv: enc.iv,
    tokenTag: enc.tag,
    ...columnasDelSecreto(input.webhookSecret),
    status: "connected" as const,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(schema.messengerCredentials)
      .set(values)
      .where(eq(schema.messengerCredentials.id, existing.id));
    return;
  }
  await db
    .insert(schema.messengerCredentials)
    .values({ id: newId("credentials"), ...values });
}

/** O token morreu: os envios são pausados e a UI pede para reconectar. */
export async function markMessengerReconnectRequired(
  organizationId: string
): Promise<void> {
  await getDb()
    .update(schema.messengerCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(eq(schema.messengerCredentials.organizationId, organizationId));
}

export function tokenLast4(token: string): string {
  return token.slice(-4);
}
