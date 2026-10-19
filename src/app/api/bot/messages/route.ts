import {
  MAX_TEXT_CHARS_ANY_CHANNEL,
  TEXT_TOO_LONG_ANY_CHANNEL,
} from "@/server/channels/capabilities";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { SendError, sendText } from "@/server/inbox/send";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  // 022: el tope de aquí es el del canal que más admite; el de cada canal
  // lo comprueba el envío y sale como el mismo 422 `invalid_body` de siempre.
  text: z.string().min(1).max(MAX_TEXT_CHARS_ANY_CHANNEL, TEXT_TOO_LONG_ANY_CHANNEL),
});

/**
 * Envío del cerebro externo A TRAVÉS del CRM: el token de WhatsApp nunca sale
 * de aquí. Usa el mismo camino que el composer de la bandeja (`sendText`), así
 * que el mensaje queda en el hilo marcado como IA, respeta la ventana de 24 h
 * y hereda el guard de sandbox del Laboratorio.
 *
 * 409 tipados: ai_paused (un humano tomó la conversación) · window_closed ·
 * sandbox_violation · message_limit (022: el canal no admite más mensajes
 * hasta que el cliente escriba; hoy, el tope de TikTok).
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

  // Gate de handoff: el bot JAMÁS habla sobre una conversación pausada. Se
  // relee aquí porque entre que el bot pidió el contexto y armó su respuesta
  // (segundos de un LLM) el dueño pudo haber tomado la conversación.
  const db = getDb();
  const convs = await db
    .select({
      aiEnabled: schema.conversation.aiEnabled,
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
  const conv = convs[0];
  if (!conv) return apiError(404, "not_found", "Conversa não encontrada");
  if (!conv.aiEnabled || conv.handoffAt) {
    return apiError(409, "ai_paused", "A IA está pausada nesta conversa");
  }

  try {
    const result = await sendText({
      conversationId: body.data.conversationId,
      organizationId,
      text: body.data.text,
      aiGenerated: true,
    });
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof SendError) {
      if (err.code === "window_closed") {
        return apiError(409, "window_closed", err.message);
      }
      if (err.code === "sandbox_violation") {
        return apiError(409, "sandbox_violation", err.message);
      }
      if (err.code === "message_limit") {
        return apiError(409, "message_limit", err.message);
      }
      // Un texto de más de 4,096 caracteres por WhatsApp ya daba 422
      // `invalid_body` (lo cortaba el esquema): se conserva el código.
      if (err.code === "text_too_long") {
        return apiError(422, "invalid_body", err.message);
      }
      return apiError(502, err.code, err.message);
    }
    throw err;
  }
}
