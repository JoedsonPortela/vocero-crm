import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { recordLeadCreated } from "@/server/leads/stage-history";
import type { StageChangeSource } from "@/lib/types";

/**
 * Atividade do lead ao receber uma mensagem (US2): se o contato não tiver lead,
 * cria-se na primeira etapa do pipeline; se tiver, atualiza-se sua
 * última atividade.
 */
export async function onLeadActivity(
  organizationId: string,
  contactId: string,
  at: Date
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(eq(schema.lead.contactId, contactId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(schema.lead)
      .set({ lastActivityAt: at, updatedAt: new Date() })
      .where(eq(schema.lead.id, existing[0].id));
    return;
  }

  await createLeadForContact({ organizationId, contactId, at });
}

/**
 * Cria o lead de um contato. Compartilham-no o webhook (sem `stageId`: primeira
 * etapa aberta) e a captura manual (com a etapa que o dono escolher). Vive em
 * um só lugar de propósito: o cálculo da posição, o `onConflictDoNothing`
 * sobre `lead_contact_uq` e o registro no histórico são sutis o bastante
 * para que duas cópias divirjam na primeira mudança.
 *
 * Devolve `null` se o pipeline não tiver etapas abertas — quem chama decide
 * se isso é um erro a mostrar (captura manual) ou um silêncio aceitável
 * (webhook: jamais deve derrubar a ingestão de uma mensagem).
 */
export async function createLeadForContact(input: {
  organizationId: string;
  contactId: string;
  stageId?: string;
  at?: Date;
  /** Quem deu de alta: o webhook é `sistema`, a captura manual `dono`. */
  source?: StageChangeSource;
  actorUserId?: string | null;
}): Promise<{ id: string; stageId: string } | null> {
  const db = getDb();

  let stageId = input.stageId;
  if (!stageId) {
    const firstStage = await db
      .select({ id: schema.pipelineStage.id })
      .from(schema.pipelineStage)
      .where(
        and(
          eq(schema.pipelineStage.organizationId, input.organizationId),
          eq(schema.pipelineStage.kind, "open")
        )
      )
      .orderBy(asc(schema.pipelineStage.position))
      .limit(1);
    if (!firstStage[0]) return null;
    stageId = firstStage[0].id;
  }

  const maxPos = await db
    .select({ max: sql<number>`coalesce(max(${schema.lead.position}), -1)` })
    .from(schema.lead)
    .where(
      and(
        eq(schema.lead.organizationId, input.organizationId),
        eq(schema.lead.stageId, stageId)
      )
    );

  const inserted = await db
    .insert(schema.lead)
    .values({
      id: newId("lead"),
      organizationId: input.organizationId,
      contactId: input.contactId,
      stageId,
      position: (maxPos[0]?.max ?? -1) + 1,
      lastActivityAt: input.at ?? null,
    })
    .onConflictDoNothing({ target: [schema.lead.contactId] })
    .returning({ id: schema.lead.id, stageId: schema.lead.stageId });

  const creado = inserted[0];
  if (!creado) return null;

  // O nascimento do lead é o primeiro evento do funil: sem ele, "prospectos
  // que entraram no período" não se poderia contar pelo histórico. Fica aqui
  // DENTRO e não em quem chama, porque há dois caminhos que criam leads e o
  // segundo que alguém adicione o esqueceria. E fica depois de verificar `creado`
  // porque `onConflictDoNothing` não devolve linha quando outro webhook
  // simultâneo ganhou a corrida — esse já anotou o seu.
  await recordLeadCreated({
    organizationId: input.organizationId,
    leadId: creado.id,
    contactId: input.contactId,
    stageId: creado.stageId,
    occurredAt: input.at,
    actorUserId: input.actorUserId ?? null,
    source: input.source ?? "sistema",
  });

  return creado;
}
