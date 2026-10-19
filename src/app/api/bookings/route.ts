import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { parseRangeQuery } from "@/lib/time/calendar";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { listBookings, listBookingsInRange } from "@/server/agenda/queries";
import { getSettings } from "@/server/agenda/settings";
import { createBlock, createSessionBooking } from "@/server/agenda/service";
import { bookingErrorResponse, bookingPayload } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

/**
 * 215 — Com `?from=AAAA-MM-DD&to=AAAA-MM-DD` (dias do negócio, inclusivos,
 * máximo 92), TODOS os agendamentos desse intervalo para o calendário, em ordem, mais
 * o que a tela precisa para desenhá-las: `timezone`, `weeklyHours`,
 * `range` e `truncated` (limite de segurança de 3 000).
 *
 * Sem parâmetros, responde EXATAMENTE o de sempre (`{ bookings }`, as
 * últimas 200): é o que leem os scripts E2E de 015. Um intervalo inválido
 * (só um dos dois, data inexistente, invertido ou longo demais) é 422
 * `invalid_range`.
 */
export const GET = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const url = new URL(req.url);
  const query = parseRangeQuery(url.searchParams.get("from"), url.searchParams.get("to"));
  if (!query.ok) return apiError(422, "invalid_range", query.message);
  if (!query.range) {
    const bookings = await listBookings(session.organizationId);
    return Response.json({ bookings });
  }

  const settings = await getSettings(session.organizationId);
  const { bookings, truncated } = await listBookingsInRange(
    session.organizationId,
    query.range,
    settings
  );
  return Response.json({
    bookings,
    timezone: settings.timezone,
    weeklyHours: settings.weeklyHours,
    range: query.range,
    truncated,
  });
});

const postSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    contactId: z.string().min(1),
    conversationId: z.string().min(1).nullish(),
    startUtc: z.string().min(1),
    notes: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("block"),
    startUtc: z.string().min(1),
    durationMinutes: z.number().int().min(5).max(600),
    notes: z.string().nullish(),
  }),
]);

/**
 * 015 — O operador agenda ou bloqueia.
 *
 * Responde **201**, igual à superfície do bot: o código de criação é
 * contrato, não um detalhe.
 *
 * Diferentemente do agente, o operador NÃO passa por `offered_slot`: escolhe da
 * disponibilidade que está vendo na tela. A revalidação e a trava
 * anti dupla reserva valem do mesmo jeito.
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  try {
    if (body.data.kind === "block") {
      const block = await createBlock({
        organizationId: session.organizationId,
        startUtc: body.data.startUtc,
        durationMinutes: body.data.durationMinutes,
        notes: body.data.notes ?? null,
      });
      return Response.json({ booking: { id: block.id } }, { status: 201 });
    }

    const result = await createSessionBooking({
      organizationId: session.organizationId,
      contactId: body.data.contactId,
      conversationId: body.data.conversationId ?? null,
      startUtc: body.data.startUtc,
      notes: body.data.notes ?? null,
      source: "manual",
      requireOffer: false,
    });
    return Response.json(
      { booking: { id: result.booking.id }, ...bookingPayload(result) },
      { status: 201 }
    );
  } catch (err) {
    return bookingErrorResponse(err);
  }
});
