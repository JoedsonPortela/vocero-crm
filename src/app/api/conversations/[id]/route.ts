import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { newId } from "@/lib/db/ids";
import { construirEventoOlvido } from "@/server/brains/contract";
import { avisarOlvido, type ResultadoOlvido } from "@/server/brains/deliver";
import { publish } from "@/server/events/bus";
import { eliminarConversacion } from "@/server/inbox/eliminar";
import { serializeConversation, getConversation, updateConversation } from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  aiEnabled: z.boolean().optional(),
  reactivate: z.boolean().optional(),
  markRead: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const updated = await updateConversation(session.organizationId, id, body.data);
  if (!updated) return apiError(404, "not_found", "Conversa não encontrada");

  const row = await getConversation(session.organizationId, id);
  if (row) {
    const dto = serializeConversation(
      row.conversation,
      row.contact,
      null,
      null,
      row.anuncio
    );
    publish(session.organizationId, {
      type: "conversation.updated",
      data: { conversation: dto },
    });
    return Response.json({ conversation: dto });
  }
  return Response.json({ conversation: null });
});

const FECHA_DE_CITA = new Intl.DateTimeFormat("es-MX", { dateStyle: "long" });

/**
 * 026 — Exclui a conversa e pede ao cérebro que a esqueça.
 *
 * `?contacto=1` leva também a pessoa embora: contato, lead e citas passadas.
 * É irreversível nos dois casos, e por isso exige papel de configuração
 * (proprietário ou administrador) e não apenas operar a bandeja.
 */
export const DELETE = withAuth(async (session, req: Request, ctx: Params) => {
  if (!canConfigure(session.role)) {
    return apiError(
      403,
      "forbidden",
      "Somente quem administra o negócio pode excluir conversas"
    );
  }
  const { id } = await ctx.params;
  const alcance =
    new URL(req.url).searchParams.get("contacto") === "1" ? "contacto" : "hilo";

  const resultado = await eliminarConversacion(session.organizationId, id, alcance);
  if (!resultado.ok) {
    if (resultado.motivo === "cita_pendiente") {
      return apiError(
        409,
        "cita_pendiente",
        `Tiene una cita agendada para el ${FECHA_DE_CITA.format(resultado.cuando)}. Cancélala en Citas antes de eliminar.`
      );
    }
    return apiError(404, "not_found", "Conversa não encontrada");
  }

  // Irreversível e sem lixeira: que ao menos fique registrado quem e quando. Só ids.
  console.info(
    `[bandeja] ${session.userId} eliminó ${id} (${alcance}) en ${session.organizationId}`
  );

  // O aviso vem DEPOIS da exclusão e não a condiciona: o que foi pedido já
  // aconteceu, e um cérebro fora do ar não pode deixar a conversa na bandeja.
  let agente: ResultadoOlvido = "no_aplica";
  const deletedAt = new Date();
  for (const conversacion of resultado.conversaciones) {
    const aviso = await avisarOlvido(
      construirEventoOlvido({
        eventId: newId("olvido"),
        organization: resultado.organization,
        conversation: conversacion,
        contact: resultado.contact,
        deletedAt,
      })
    );
    if (aviso === "sin_confirmar" || agente === "no_aplica") agente = aviso;
  }

  for (const conversacion of resultado.conversaciones) {
    publish(session.organizationId, {
      type: "conversation.deleted",
      data: {
        conversationId: conversacion.id,
        contactId: resultado.contact.id,
        contactDeleted: alcance === "contacto",
      },
    });
  }
  return Response.json({ ok: true, alcance, agente });
});
