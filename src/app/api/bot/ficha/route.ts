import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { upsertFicha } from "@/server/bot/ficha";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  // Objeto livre de propósito: as chaves são definidas pelo negócio, e o servidor
  // tolera o drift do LLM em vez de puni-lo com um 422 (ver server/bot/ficha).
  ficha: z.record(z.unknown()),
});

/**
 * Ficha de qualificação do lead, escrita por um cérebro externo.
 * Merge campo a campo com o que já existia; `null` explícito apaga a chave.
 * Devolve a ficha COMPLETA resultante, não só o patch, para que o bot não
 * precise manter a sua própria cópia sincronizada.
 */
export async function PUT(req: Request) {
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
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, body.data.conversationId)
      )
    )
    .limit(1);
  if (!rows[0]) return apiError(404, "not_found", "Conversa não encontrada");

  const result = await upsertFicha({
    organizationId,
    contactId: rows[0].contactId,
    ficha: body.data.ficha,
  });
  if (!result) return apiError(404, "not_found", "Contacto no encontrado");
  return Response.json(result);
}
