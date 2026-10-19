import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { publish } from "@/server/events/bus";
import { moveLeadToStage } from "@/server/leads/stage-history";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
});

/**
 * Reinício de UMA conversa para a linha de testes do operador: IA
 * reativada (sai do handoff) e lead de volta à primeira etapa. O
 * histórico da inbox NÃO é apagado: é auditoria. Quem invoca é o cérebro externo
 * quando um número da sua allowlist envia `/reset`.
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "A instância ainda não tem organização");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const rows = await db
    .select({
      id: schema.conversation.id,
      contactId: schema.conversation.contactId,
    })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, body.data.conversationId)
      )
    )
    .limit(1);
  const conv = rows[0];
  if (!conv) return apiError(404, "not_found", "Conversa não encontrada");

  await db
    .update(schema.conversation)
    .set({
      aiEnabled: true,
      handoffAt: null,
      handoffReason: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversation.id, conv.id));

  // Etapa no início do funil (best-effort: sem etapas o reset não quebra).
  try {
    const stages = await db
      .select()
      .from(schema.pipelineStage)
      .where(eq(schema.pipelineStage.organizationId, organizationId));
    const first = [...stages].sort((a, b) => a.position - b.position)[0];
    const leadRows = await db
      .select({ id: schema.lead.id })
      .from(schema.lead)
      .where(
        and(
          eq(schema.lead.organizationId, organizationId),
          eq(schema.lead.contactId, conv.contactId)
        )
      )
      .limit(1);
    if (first && leadRows[0]) {
      // Pela porta única: devolver a conversa de testes ao início
      // também é um movimento, e o histórico precisa poder explicar por
      // que um lead retrocedeu de etapa.
      await moveLeadToStage({
        organizationId,
        leadId: leadRows[0].id,
        toStageId: first.id,
        source: "sistema",
      });
    }
  } catch (err) {
    console.warn(`[bot/reset] reinicio de etapa falló: ${err}`);
  }

  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conv.id } },
  });
  return Response.json({ ok: true });
}
