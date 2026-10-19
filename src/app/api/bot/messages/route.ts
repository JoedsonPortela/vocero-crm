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
  // 022: o teto daqui é o do canal que mais admite; o de cada canal
  // é verificado pelo envio e sai como o mesmo 422 `invalid_body` de sempre.
  text: z.string().min(1).max(MAX_TEXT_CHARS_ANY_CHANNEL, TEXT_TOO_LONG_ANY_CHANNEL),
});

/**
 * Envio do cérebro externo ATRAVÉS do CRM: o token do WhatsApp nunca sai
 * daqui. Usa o mesmo caminho do composer da bandeja (`sendText`), assim
 * a mensagem fica no fio marcada como IA, respeita a janela de 24 h
 * e herda a guarda de sandbox do Laboratório.
 *
 * 409 tipados: ai_paused (um humano assumiu a conversa) · window_closed ·
 * sandbox_violation · message_limit (022: o canal não admite mais mensagens
 * até o cliente escrever; hoje, o teto do TikTok).
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

  // Trava de handoff: o bot JAMAIS fala sobre uma conversa pausada. Relê-se
  // aqui porque, entre o bot pedir o contexto e montar a resposta
  // (segundos de um LLM), o dono pode ter assumido a conversa.
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
      // Um texto com mais de 4.096 caracteres no WhatsApp já dava 422
      // `invalid_body` (o esquema cortava): o código é mantido.
      if (err.code === "text_too_long") {
        return apiError(422, "invalid_body", err.message);
      }
      return apiError(502, err.code, err.message);
    }
    throw err;
  }
}
