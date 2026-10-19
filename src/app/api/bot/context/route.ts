import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { serializeFicha } from "@/server/bot/ficha";
import { findContactByIdentity } from "@/server/inbox/identity";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import { windowMsFor } from "@/server/channels/capabilities";
import { citasParaContexto } from "@/server/agenda/context";

export const dynamic = "force-dynamic";

/**
 * Contexto conversacional para um cérebro externo (somente leitura).
 * GET /api/bot/context?identity=... | ?waIdentity=... | ?conversationId=...
 *
 * `identity` é o nome neutro (há contatos que não são do WhatsApp).
 * `waIdentity` continua aceito e presente na resposta porque é
 * contrato publicado: há cérebros externos em produção que dependem dele.
 * Não tem data de retirada.
 *
 * NÃO devolve o histórico de mensagens: o bot leva a sua própria memória da
 * conversa. O que sai aqui é o que só o CRM sabe — quem é a
 * pessoa, se um humano assumiu o controle e se a janela de 24 h ainda está aberta
 * (e, com a agenda ligada, quais citas ela tem: `booking`).
 */
export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "A instância ainda não tem organização");
  }

  const url = new URL(req.url);
  const waIdentity =
    url.searchParams.get("identity") ?? url.searchParams.get("waIdentity");
  const conversationId = url.searchParams.get("conversationId");
  if (!waIdentity && !conversationId) {
    return apiError(422, "invalid", "Falta identity (ou waIdentity) ou conversationId");
  }

  const db = getDb();

  let contact: typeof schema.contact.$inferSelect | undefined;
  let conversation: typeof schema.conversation.$inferSelect | undefined;

  if (conversationId) {
    const rows = await db
      .select({ conversation: schema.conversation, contact: schema.contact })
      .from(schema.conversation)
      .innerJoin(
        schema.contact,
        eq(schema.conversation.contactId, schema.contact.id)
      )
      .where(
        and(
          eq(schema.conversation.organizationId, organizationId),
          eq(schema.conversation.id, conversationId)
        )
      )
      .limit(1);
    contact = rows[0]?.contact;
    conversation = rows[0]?.conversation;
  } else if (waIdentity) {
    // Exata primeiro; se não, a reconciliação da ingestão (R11): quem
    // escreveu com telefone e agora chega só com BSUID é o mesmo contato.
    contact = await findContactByIdentity(organizationId, waIdentity);
    if (contact) {
      // A conversa do Laboratório nunca é resolvida por identidade: esse
      // caminho é para o bot de produção, que jamais deve falar com um
      // cliente simulado.
      const convs = await db
        .select()
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.organizationId, organizationId),
            eq(schema.conversation.contactId, contact.id),
            eq(schema.conversation.isTest, false)
          )
        )
        .limit(1);
      conversation = convs[0];
    }
  }

  if (!contact || !conversation) {
    return apiError(404, "not_found", "Conversa não encontrada");
  }

  const [leadRows, booking] = await Promise.all([
    db
      .select({ lead: schema.lead, stage: schema.pipelineStage })
      .from(schema.lead)
      .innerJoin(
        schema.pipelineStage,
        eq(schema.lead.stageId, schema.pipelineStage.id)
      )
      .where(
        and(
          eq(schema.lead.organizationId, organizationId),
          eq(schema.lead.contactId, contact.id)
        )
      )
      .limit(1),
    citasParaContexto(organizationId, contact.id),
  ]);

  return Response.json({
    contact: {
      id: contact.id,
      name: contact.name,
      /** Nome neutro (014). Prefira este em clientes novos. */
      identity: contact.waIdentity,
      /** Alias herdado: continua aqui para não quebrar bots já implantados. */
      waIdentity: contact.waIdentity,
      channel: contact.channel,
      phone: contact.phone,
      ficha: serializeFicha(contact),
    },
    conversation: {
      id: conversation.id,
      // Uma só verdade para o bot: se há handoff, a IA está desligada
      // mesmo que a flag continue true.
      aiEnabled: conversation.aiEnabled && !conversation.handoffAt,
      handoffAt: conversation.handoffAt?.toISOString() ?? null,
      // 022: a janela é a do canal da conversa.
      windowOpen: isWindowOpen(
        conversation.lastInboundAt,
        new Date(),
        windowMsFor(conversation.channel)
      ),
      windowRemainingMs: windowRemainingMs(
        conversation.lastInboundAt,
        new Date(),
        windowMsFor(conversation.channel)
      ),
    },
    lead: leadRows[0]
      ? { id: leadRows[0].lead.id, stageName: leadRows[0].stage.name }
      : null,
    /**
     * 015 — As citas do contato. FALTA com a agenda desligada (ou se não
     * puderem ser lidas): um cérebro que não o recebe não afirma nada sobre citas,
     * e um que não o lê não muda. Aditivo.
     */
    ...(booking ? { booking } : {}),
  });
}
