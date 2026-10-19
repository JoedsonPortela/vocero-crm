import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { LossReason, StageChangeSource } from "@/lib/types";
import { reportStageChange } from "@/server/attribution/conversions";

/**
 * A ÚNICA porta que escreve `lead.stage_id`.
 *
 * Regra rígida: mover um lead e registrar a movimentação são
 * a mesma operação, na mesma transação. Hoje há quatro caminhos que
 * mudam de etapa (o dono arrasta, o bot avança, o agente in-process, a
 * realocação ao apagar uma etapa); se cada um copiasse o "anota o evento",
 * o quinto que alguém adicionasse o esqueceria. E esquecê-lo NÃO dá erro: só faz
 * com que os gráficos mintam meses depois.
 *
 * Um unit test de vigilância (`tests/unit/stage-history-guard.test.ts`) varre
 * `src/` e falha se aparecer uma escrita de `stageId` fora deste arquivo.
 * Não o "conserte" movendo o UPDATE para outro lado: é uma salvaguarda.
 */

type LeadRow = typeof schema.lead.$inferSelect;

export type MoveResult =
  | { ok: true; lead: LeadRow; changed: boolean }
  | {
      ok: false;
      reason: "lead_not_found" | "stage_not_found" | "loss_reason_required";
    };

export type MoveInput = {
  organizationId: string;
  leadId: string;
  toStageId: string;
  /** Posição dentro da coluna de destino. */
  position?: number;
  /** Quem o moveu; NULL quando não foi uma pessoa. */
  actorUserId?: string | null;
  source: StageChangeSource;
  /** Obrigatório ao ENTRAR em uma etapa perdida. */
  lossReason?: LossReason | null;
  lossNote?: string | null;
  /** Padrão: agora. */
  occurredAt?: Date;
  /**
   * Outros campos do lead que são gravados no MESMO update. Existe para que
   * o PATCH do Pipeline não precise fazer duas viagens quando o dono move
   * o cartão e altera o valor na mesma ação.
   */
  extra?: Record<string, unknown>;
};

export async function moveLeadToStage(input: MoveInput): Promise<MoveResult> {
  const db = getDb();
  const occurredAt = input.occurredAt ?? new Date();

  // 016: anota-se aqui dentro e se reporta à Meta DEPOIS do commit. Uma
  // chamada de rede dentro da transação a manteria aberta enquanto a
  // Meta pensa, e uma conversão jamais vale uma transação longa.
  let toStageKind: "open" | "won" | "lost" | null = null;

  const result = await db.transaction(async (tx) => {
    const leadRows = await tx
      .select({ lead: schema.lead, stage: schema.pipelineStage })
      .from(schema.lead)
      .leftJoin(
        schema.pipelineStage,
        eq(schema.lead.stageId, schema.pipelineStage.id)
      )
      .where(
        scoped(
          schema.lead.organizationId,
          input.organizationId,
          eq(schema.lead.id, input.leadId)
        )
      )
      .limit(1);

    const current = leadRows[0];
    if (!current) return { ok: false as const, reason: "lead_not_found" as const };

    const targetRows = await tx
      .select()
      .from(schema.pipelineStage)
      .where(
        scoped(
          schema.pipelineStage.organizationId,
          input.organizationId,
          eq(schema.pipelineStage.id, input.toStageId)
        )
      )
      .limit(1);

    const target = targetRows[0];
    if (!target) return { ok: false as const, reason: "stage_not_found" as const };

    const changed = current.lead.stageId !== target.id;
    toStageKind = target.kind;

    // O motivo é exigido ao ENTRAR na etapa perdida. Reordenar um cartão
    // que já estava ali não volta a perguntar.
    if (changed && target.kind === "lost" && !input.lossReason) {
      return { ok: false as const, reason: "loss_reason_required" as const };
    }

    const updated = await tx
      .update(schema.lead)
      .set({
        ...(input.extra ?? {}),
        stageId: target.id,
        ...(input.position !== undefined ? { position: input.position } : {}),
        updatedAt: new Date(),
      })
      .where(
        scoped(
          schema.lead.organizationId,
          input.organizationId,
          eq(schema.lead.id, input.leadId)
        )
      )
      .returning();

    const leadRow = updated[0];
    if (!leadRow) return { ok: false as const, reason: "lead_not_found" as const };

    if (changed) {
      await tx.insert(schema.leadStageEvent).values({
        id: newId("leadStageEvent"),
        organizationId: input.organizationId,
        leadId: leadRow.id,
        contactId: leadRow.contactId,
        fromStageId: current.stage?.id ?? null,
        fromStageName: current.stage?.name ?? null,
        toStageId: target.id,
        toStageName: target.name,
        toStageKind: target.kind,
        occurredAt,
        actorUserId: input.actorUserId ?? null,
        source: input.source,
        approximate: false,
        lossReason: target.kind === "lost" ? input.lossReason ?? null : null,
        lossNote: target.kind === "lost" ? input.lossNote ?? null : null,
      });
    }

    return { ok: true as const, lead: leadRow, changed };
  });

  // 016 — Atribuição: se esta instância a tiver ligada, entrar na etapa
  // que o negócio marcou como "lead qualificado" ou em uma etapa ganha é
  // reportado à Meta. Best-effort e já fora da transação: uma falha aqui
  // jamais pode custar a movimentação do lead, que já está firme.
  if (result.ok && result.changed && toStageKind !== null) {
    await reportStageChange({
      organizationId: input.organizationId,
      leadId: result.lead.id,
      contactId: result.lead.contactId,
      toStageId: result.lead.stageId,
      toStageKind,
    });
  }

  return result;
}

/**
 * Evento de nascimento do lead. Sem ele, o funil não teria de onde começar
 * e "prospectos que entraram" não poderia ser contado pelo histórico.
 *
 * Best-effort de propósito: quem chama vem de criar um lead (às vezes a partir
 * da ingestão de uma mensagem do WhatsApp), e uma falha aqui jamais deve derrubar esse
 * caminho. O lead sem evento apareceria com sua data de criação de qualquer forma.
 */
export async function recordLeadCreated(input: {
  organizationId: string;
  leadId: string;
  contactId: string;
  stageId: string;
  occurredAt?: Date;
  actorUserId?: string | null;
  source?: StageChangeSource;
}): Promise<void> {
  const db = getDb();
  const stage = await db
    .select({
      id: schema.pipelineStage.id,
      name: schema.pipelineStage.name,
      kind: schema.pipelineStage.kind,
    })
    .from(schema.pipelineStage)
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        input.organizationId,
        eq(schema.pipelineStage.id, input.stageId)
      )
    )
    .limit(1);

  const s = stage[0];
  if (!s) return;

  await db.insert(schema.leadStageEvent).values({
    id: newId("leadStageEvent"),
    organizationId: input.organizationId,
    leadId: input.leadId,
    contactId: input.contactId,
    fromStageId: null,
    fromStageName: null,
    toStageId: s.id,
    toStageName: s.name,
    toStageKind: s.kind,
    occurredAt: input.occurredAt ?? new Date(),
    actorUserId: input.actorUserId ?? null,
    source: input.source ?? "sistema",
    approximate: false,
    // Um lead não pode nascer perdido: o CHECK do banco o permitiria só
    // com motivo, e aqui nunca há um para capturar.
    lossReason: null,
    lossNote: null,
  });
}

/**
 * Realocação em massa ao apagar uma etapa. Um evento por lead: o funil precisa
 * poder explicar por que 30 cartões mudaram de coluna no mesmo minuto.
 */
export async function relocateLeadsFromStage(input: {
  organizationId: string;
  fromStageId: string;
  toStageId: string;
  actorUserId?: string | null;
}): Promise<number> {
  const db = getDb();
  const leads = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        input.organizationId,
        eq(schema.lead.stageId, input.fromStageId)
      )
    )
    .orderBy(asc(schema.lead.position));

  const stageRows = await db
    .select({ name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(
      scoped(
        schema.pipelineStage.organizationId,
        input.organizationId,
        eq(schema.pipelineStage.id, input.fromStageId)
      )
    )
    .limit(1);
  const fromName = stageRows[0]?.name ?? "una etapa eliminada";

  let moved = 0;
  for (const l of leads) {
    const res = await moveLeadToStage({
      organizationId: input.organizationId,
      leadId: l.id,
      toStageId: input.toStageId,
      actorUserId: input.actorUserId ?? null,
      source: "sistema",
      // Se o destino resultar ser a etapa perdida, o motivo não se pode
      // inventar, mas também não pode faltar: registra-se o que de fato aconteceu.
      lossReason: "otro",
      lossNote: `Reubicado al eliminar la etapa "${fromName}"`,
    });
    if (res.ok) moved += 1;
  }
  return moved;
}

/** O último motivo de perda registrado de um lead, se houver. */
export async function lastLossReason(
  organizationId: string,
  leadId: string
): Promise<{ reason: LossReason; note: string | null; at: Date } | null> {
  const db = getDb();
  const rows = await db
    .select({
      lossReason: schema.leadStageEvent.lossReason,
      lossNote: schema.leadStageEvent.lossNote,
      occurredAt: schema.leadStageEvent.occurredAt,
    })
    .from(schema.leadStageEvent)
    .where(
      scoped(
        schema.leadStageEvent.organizationId,
        organizationId,
        and(
          eq(schema.leadStageEvent.leadId, leadId),
          eq(schema.leadStageEvent.toStageKind, "lost")
        )
      )
    )
    .orderBy(asc(schema.leadStageEvent.occurredAt))
    .limit(50);

  const last = rows.filter((r) => r.lossReason).at(-1);
  if (!last?.lossReason) return null;
  return {
    reason: last.lossReason,
    note: last.lossNote,
    at: last.occurredAt,
  };
}
