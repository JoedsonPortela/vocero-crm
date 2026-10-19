import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { publish } from "@/server/events/bus";
import { toHandoffReason } from "@/server/bot/handoff";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  /**
   * Texto livre de propósito: o catálogo é aplicado depois, com fallback
   * (ver `server/bot/handoff`). Um motivo estranho não pode custar o handoff.
   */
  reason: z.string().optional(),
});

/**
 * Handoff pedido pelo cérebro externo: pausa a IA e deixa a conversa
 * para um humano. Idempotente — só escreve na transição, então
 * repetir não sobrescreve a hora nem o motivo original.
 *
 * É a mesma pausa do toggle da bandeja, e publica o mesmo evento,
 * então o app vê ao vivo sem atualizar.
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
      handoffAt: schema.conversation.handoffAt,
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

  if (!conv.handoffAt) {
    await db
      .update(schema.conversation)
      .set({
        aiEnabled: false,
        handoffAt: new Date(),
        handoffReason: toHandoffReason(body.data.reason),
        updatedAt: new Date(),
      })
      .where(eq(schema.conversation.id, conv.id));
    publish(organizationId, {
      type: "conversation.updated",
      data: { conversation: { id: conv.id } },
    });
  }
  return Response.json({ ok: true });
}
