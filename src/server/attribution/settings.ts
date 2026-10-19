import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";

/**
 * 016 — A conexão do negócio com o seu dataset da Meta.
 *
 * O token é criptografado com o MESMO mecanismo do WhatsApp (`lib/crypto`,
 * AES-256-GCM), e não com um segundo: duas formas de guardar um segredo é uma a
 * mais para auditar.
 */

export type CapiSettings = {
  datasetId: string;
  token: string;
  qualifiedStageId: string | null;
  status: "connected" | "error";
};

/** O que o cliente pode ver. O token NUNCA sai: só os seus últimos 4. */
export type CapiSettingsView = {
  datasetId: string;
  status: "connected" | "error";
  tokenLast4: string;
  qualifiedStageId: string | null;
};

export async function getCapiSettings(
  organizationId: string
): Promise<CapiSettings | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.capiSettings)
    .where(scoped(schema.capiSettings.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    datasetId: row.datasetId,
    token: decryptSecret({
      cipher: row.tokenCipher,
      iv: row.tokenIv,
      tag: row.tokenTag,
    }),
    qualifiedStageId: row.qualifiedStageId,
    status: row.status,
  };
}

export async function getCapiSettingsView(
  organizationId: string
): Promise<CapiSettingsView | null> {
  const settings = await getCapiSettings(organizationId);
  if (!settings) return null;
  return {
    datasetId: settings.datasetId,
    status: settings.status,
    tokenLast4: settings.token.slice(-4),
    qualifiedStageId: settings.qualifiedStageId,
  };
}

export async function saveCapiSettings(input: {
  organizationId: string;
  datasetId: string;
  token: string;
  qualifiedStageId: string | null;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.token);
  await db
    .insert(schema.capiSettings)
    .values({
      id: newId("capiSettings"),
      organizationId: input.organizationId,
      datasetId: input.datasetId,
      tokenCipher: enc.cipher,
      tokenIv: enc.iv,
      tokenTag: enc.tag,
      qualifiedStageId: input.qualifiedStageId,
      status: "connected",
    })
    .onConflictDoUpdate({
      target: [schema.capiSettings.organizationId],
      set: {
        datasetId: input.datasetId,
        tokenCipher: enc.cipher,
        tokenIv: enc.iv,
        tokenTag: enc.tag,
        qualifiedStageId: input.qualifiedStageId,
        status: "connected",
        updatedAt: new Date(),
      },
    });
}

export async function deleteCapiSettings(
  organizationId: string
): Promise<void> {
  const db = getDb();
  // Os eventos já registrados NÃO são apagados: são o registro do que foi dito
  // à Meta, e isso não deixa de ser verdade porque o negócio desconectou.
  await db
    .delete(schema.capiSettings)
    .where(scoped(schema.capiSettings.organizationId, organizationId));
}

/** Essa etapa é desta organização? (multi-tenancy: III). */
export async function stageBelongsToOrg(
  organizationId: string,
  stageId: string
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.pipelineStage.id })
    .from(schema.pipelineStage)
    .where(
      and(
        eq(schema.pipelineStage.organizationId, organizationId),
        eq(schema.pipelineStage.id, stageId)
      )
    )
    .limit(1);
  return rows.length > 0;
}
