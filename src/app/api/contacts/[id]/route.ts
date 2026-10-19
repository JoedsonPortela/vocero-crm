import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  getContactById,
  getContactStage,
  serializeContact,
} from "@/server/contacts";
import { upsertFicha } from "@/server/bot/ficha";
import { pauseConversations } from "@/server/contacts-import";
import { cuentaComoAnuncio } from "@/lib/anuncios";
import {
  anuncioDelContacto,
  repararImagenSiFalta,
} from "@/server/attribution/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const contact = await getContactById(session.organizationId, id);
  if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
  const [stageRow, anuncio] = await Promise.all([
    getContactStage(session.organizationId, id),
    anuncioDelContacto(session.organizationId, id),
  ]);
  // 018 — Sem imagem ainda: tenta de novo em segundo plano e chega via SSE.
  if (anuncio && !anuncio.imageAssetId) {
    repararImagenSiFalta(session.organizationId, id);
  }
  return Response.json({
    contact: serializeContact(contact, null, null, cuentaComoAnuncio(anuncio)),
    // 018 — de qual anúncio chegou, ou null se escreveu por conta própria.
    anuncio,
    stage: stageRow
      ? {
          id: stageRow.stage.id,
          name: stageRow.stage.name,
          position: stageRow.stage.position,
          kind: stageRow.stage.kind,
        }
      : null,
    lead: stageRow ? { id: stageRow.lead.id } : null,
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(4000).nullable().optional(),
  /** 027 — O agente não responde a esta pessoa; ela é levada para a conversa dela. */
  aiPaused: z.boolean().optional(),
  archived: z.boolean().optional(),
  /**
   * Patch da ficha: só as chaves que mudam. `null` apaga uma chave.
   * Não é uma substituição — o agente continua escrevendo enquanto o dono
   * corrige, e mandar a ficha inteira faria com que o último a salvar
   * apagasse o que o outro acabou de descobrir.
   */
  ficha: z.record(z.unknown()).optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  // A ficha passa pela sua própria porta — a MESMA que usa o cérebro externo em
  // `PUT /api/bot/ficha` — para herdar o merge e os limites. Gravá-la aqui
  // com um `set` simples seria um segundo caminho com outras regras.
  if (body.data.ficha !== undefined) {
    const res = await upsertFicha({
      organizationId: session.organizationId,
      contactId: id,
      ficha: body.data.ficha,
    });
    if (!res) return apiError(404, "not_found", "Contacto no encontrado");
  }

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (body.data.name !== undefined) {
    set.name = body.data.name;
    // Foi escrito por uma pessoa: a partir daqui o WhatsApp não o sobrescreve mais (#51).
    set.nameSource = "manual";
  }
  if (body.data.notes !== undefined) set.notes = body.data.notes;
  if (body.data.archived !== undefined) {
    set.archivedAt = body.data.archived ? new Date() : null;
  }
  if (body.data.aiPaused !== undefined) set.aiPaused = body.data.aiPaused;

  const db = getDb();
  const updated = await db
    .update(schema.contact)
    .set(set)
    .where(
      scoped(
        schema.contact.organizationId,
        session.organizationId,
        eq(schema.contact.id, id)
      )
    )
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Contacto no encontrado");
  // 027: a pausa é levada para a conversa que já exista; sem isso não
  // teria efeito até que nascesse outra.
  if (body.data.aiPaused !== undefined) {
    await pauseConversations(session.organizationId, [id], body.data.aiPaused);
  }
  const anuncio = await anuncioDelContacto(session.organizationId, id);
  return Response.json({
    contact: serializeContact(updated[0], null, null, cuentaComoAnuncio(anuncio)),
  });
});
