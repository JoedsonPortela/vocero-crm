import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getContactById } from "@/server/contacts";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import { SendError } from "@/server/inbox/send";
import { isWindowOpen } from "@/server/inbox/window";
import {
  sendTemplate,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  templateId: z.string().min(1),
  variables: z.array(z.string().trim().max(500)).max(10).optional(),
});

/**
 * Abre a conversa com um contato que NUNCA escreveu (capturado
 * à mão). O WhatsApp só permite iniciar com template aprovado; essa é uma
 * regra da Meta, não do CRM.
 *
 * A conversa é criada AQUI e não ao capturar o contato: um fio vazio
 * sujaria a Bandeja e quebraria a sua ordem pela última mensagem.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const contact = await getContactById(session.organizationId, id);
  if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
  if (!contact.phone && !contact.waIdentity) {
    return apiError(422, "no_identity", "Este contato não tem para onde enviar mensagem");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const existing = await db
    .select({ id: schema.conversation.id, lastInboundAt: schema.conversation.lastInboundAt })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        session.organizationId,
        eq(schema.conversation.contactId, id),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);

  // Gastar um template com a janela aberta é jogar dinheiro e
  // reputação do template: avisa-se em vez de enviá-lo.
  if (existing[0] && isWindowOpen(existing[0].lastInboundAt)) {
    return apiError(
      409,
      "window_open",
      "Esta pessoa te escreveu há menos de 24 h: você pode responder direto pela Caixa de entrada, sem modelo"
    );
  }

  const conversation =
    existing[0] ?? (await getOrCreateConversation(session.organizationId, id));

  try {
    const result = await sendTemplate({
      organizationId: session.organizationId,
      conversationId: conversation.id,
      templateId: body.data.templateId,
      variables: body.data.variables,
    });
    return Response.json({
      messageId: result.messageId,
      conversationId: conversation.id,
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    if (err instanceof SendError) {
      return apiError(409, err.code, err.message);
    }
    throw err;
  }
});
