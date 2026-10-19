import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { graphRequest } from "@/lib/meta/client";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ conversationId: z.string().min(1) });

/**
 * Indicador "digitando…" + marcar como lido o último inbound.
 * POST /api/bot/typing {conversationId}
 *
 * Best-effort por contrato: o bot JAMAIS precisa tentar isto de novo — se a Meta
 * falhar, responde-se 200 {ok:false} e a conversa segue. O indicador
 * dura até ~25 s ou até chegar a resposta real.
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
  const convs = await db
    .select()
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
  if (conv.isTest) {
    // Sandbox: jamais toca a API real (guardrail do Laboratório).
    return Response.json({ ok: false, reason: "sandbox" });
  }
  if (!conv.aiEnabled || conv.handoffAt) {
    // Handoff/IA pausada: um humano atende — "digitando…" aqui seria
    // mentir para o cliente. Omite-se sem tocar na Meta.
    return Response.json({ ok: false, reason: "ai_paused" });
  }

  const msgs = await db
    .select({ waMessageId: schema.message.waMessageId })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.conversationId, conv.id),
        eq(schema.message.direction, "in"),
        isNotNull(schema.message.waMessageId)
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  const wamid = msgs[0]?.waMessageId;
  if (!wamid) return Response.json({ ok: false, reason: "no_inbound" });

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    return apiError(409, "no_connection", "O WhatsApp não está conectado");
  }

  try {
    await graphRequest(`${creds.phoneNumberId}/messages`, {
      method: "POST",
      token: creds.token,
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: wamid,
        typing_indicator: { type: "text" },
      },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, reason: "meta_error" });
  }
}
