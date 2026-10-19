import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { getBranding } from "@/server/branding";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  /**
   * Opcionais desde que o lead tem valor: capturar dinheiro é um gesto
   * diferente de mover o cartão, e exigir a etapa para salvar um valor
   * obrigaria o cliente a reenviar onde estava — com o risco de movê-lo sem
   * querer se o quadro estivesse defasado. Sem `stageId` nada é movido.
   */
  stageId: z.string().min(1).optional(),
  position: z.number().int().min(0).optional(),
  /**
   * Obrigatório ao ENTRAR em uma etapa perdida. Não é validado aqui, mas na
   * porta: a regra é do domínio, não desta rota, e há mais caminhos que
   * movem cartões.
   */
  lossReason: z
    .enum([
      "precio",
      "no_es_perfil",
      "sin_presupuesto",
      "eligio_otro",
      "nunca_contesto",
      "otro",
    ])
    .optional(),
  lossNote: z.string().max(500).optional(),
  /**
   * Valor em centavos inteiros. `null` explícito o apaga; ausente o deixa como
   * estava — capturar o valor e mover o cartão são gestos distintos, e um
   * não deve sobrescrever o outro.
   */
  amountCents: z.number().int().min(0).max(1_000_000_000_00).nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  /** `null` explícito o remove; ausente o deixa como estava. */
  priority: z.enum(["alta", "media", "baja"]).nullable().optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  // O valor viaja no MESMO update que a movimentação: capturá-lo enquanto
  // se arrasta o cartão não deve custar duas viagens nem deixar um estado pela
  // metade se a segunda falhar.
  const extra: Record<string, unknown> = {};
  if (body.data.amountCents !== undefined) {
    extra.amountCents = body.data.amountCents;
    // Sem valor não há moeda para guardar: deixá-la apontando para um valor
    // apagado faria o quadro contar um lead que não tem mais número.
    extra.currency =
      body.data.amountCents === null
        ? null
        : (body.data.currency ?? (await getBranding(session.organizationId)).currency);
  }

  if (body.data.priority !== undefined) {
    extra.priority = body.data.priority;
    // A data acompanha o valor: serve para saber se a decisão é de hoje ou
    // de três semanas atrás, que é o que torna útil consultá-la.
    extra.priorityUpdatedAt = body.data.priority === null ? null : new Date();
  }

  // Sem etapa: só os campos do lead são atualizados. Não passa pela porta
  // do histórico porque não há movimentação a registrar — e a guarda
  // continua satisfeita: aqui jamais se escreve `stageId`.
  if (!body.data.stageId) {
    if (Object.keys(extra).length === 0) {
      return apiError(422, "nothing_to_update", "Não há nada para atualizar");
    }
    const db = getDb();
    const updated = await db
      .update(schema.lead)
      .set({ ...extra, updatedAt: new Date() })
      .where(
        scoped(
          schema.lead.organizationId,
          session.organizationId,
          eq(schema.lead.id, id)
        )
      )
      .returning();
    if (!updated[0]) return apiError(404, "not_found", "Lead no encontrado");
    return Response.json({ lead: updated[0] });
  }

  const res = await moveLeadToStage({
    organizationId: session.organizationId,
    leadId: id,
    toStageId: body.data.stageId,
    position: body.data.position,
    actorUserId: session.userId,
    source: "dueno",
    lossReason: body.data.lossReason ?? null,
    lossNote: body.data.lossNote ?? null,
    extra,
  });

  if (!res.ok) {
    if (res.reason === "lead_not_found") {
      return apiError(404, "not_found", "Lead no encontrado");
    }
    if (res.reason === "stage_not_found") {
      return apiError(422, "invalid_stage", "Etapa inexistente");
    }
    // O quadro abre o seu diálogo com este código: perder um negócio sem dizer
    // por quê deixa o funil sem a metade que importa.
    return apiError(
      422,
      "loss_reason_required",
      "Falta o motivo da perda"
    );
  }

  const db = getDb();
  // Notifica a bandeja para que a etapa seja refletida ao vivo (painel de
  // detalhes e ponto de etapa da lista) sem recarregar.
  const convRows = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, session.organizationId),
        eq(schema.conversation.contactId, res.lead.contactId),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);
  if (convRows[0]) {
    publish(session.organizationId, {
      type: "conversation.updated",
      data: { conversation: { id: convRows[0].id } },
    });
  }

  return Response.json({ lead: res.lead });
});
