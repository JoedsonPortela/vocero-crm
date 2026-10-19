import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  createSessionBooking,
  rescheduleForConversation,
} from "@/server/agenda/service";
import { bookingErrorResponse, bookingPayload } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

/**
 * 015 — Reservar e mover citas, para quem conduz a conversa.
 *
 * CONTRATO: criar responde **201**, mover responde **200**. Não é purismo: em
 * um sistema real, um cliente que validava `status === 200` deixou TODOS os
 * leads sem poder agendar por horas, e os mocks não detectaram isso porque
 * respondiam 200. Se você escrever um cliente, aceite 2xx.
 *
 * E o envelope do erro vem ANINHADO (`{"error":{"code":…}}`) com `slots` como
 * irmão: um mock com a forma plana escondeu o caminho de nova oferta por
 * semanas nesse mesmo sistema.
 */

const createSchema = z.object({
  conversationId: z.string().min(1),
  startUtc: z.string().min(1),
  notes: z.string().nullish(),
});

const rescheduleSchema = z.object({
  conversationId: z.string().min(1),
  startUtc: z.string().min(1),
});

export async function POST(req: Request) {
  const gate = await guard(req);
  if ("response" in gate) return gate.response;

  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  try {
    const result = await createSessionBooking({
      organizationId: gate.organizationId,
      conversationId: body.data.conversationId,
      startUtc: body.data.startUtc,
      notes: body.data.notes ?? null,
      source: "ai",
      // A regra inegociável: o agente só reserva o que já ofereceu.
      requireOffer: true,
    });
    return Response.json(bookingPayload(result), { status: 201 });
  } catch (err) {
    return bookingErrorResponse(err);
  }
}

export async function PATCH(req: Request) {
  const gate = await guard(req);
  if ("response" in gate) return gate.response;

  const body = await parseBody(req, rescheduleSchema);
  if (!body.ok) return body.response;

  try {
    const result = await rescheduleForConversation({
      organizationId: gate.organizationId,
      conversationId: body.data.conversationId,
      startUtc: body.data.startUtc,
    });
    // 200 e não 201: mover uma cita não cria um recurso novo.
    return Response.json(bookingPayload(result));
  } catch (err) {
    return bookingErrorResponse(err);
  }
}

/* Cancelar NÃO existe por esta superfície de propósito: essa decisão é do
 * dono do negócio, não do agente. O caminho é o handoff. */

type Gate = { organizationId: string } | { response: Response };

async function guard(req: Request): Promise<Gate> {
  if (!agendaEnabled()) return { response: agendaDisabledResponse() };
  const denied = requireBotKey(req);
  if (denied) return { response: denied };
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return {
      response: apiError(409, "no_org", "A instância ainda não tem organização"),
    };
  }
  return { organizationId };
}

