import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { CONNECTOR_ORDER } from "@/lib/agenda-connectors";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  CalendarSettingsError,
  getSettings,
  upsertSettings,
} from "@/server/agenda/settings";

export const dynamic = "force-dynamic";

/**
 * 015 — A configuração da agenda do negócio.
 *
 * Uma instância não configurada responde 200 com os defaults, não 404: a
 * agenda já é utilizável no dia em que é ligada.
 *
 * Nunca devolve credenciais de um conector — elas vivem no seu próprio
 * endpoint e só saem como últimos 4 dígitos.
 */
export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const settings = await getSettings(session.organizationId);
  return Response.json({ settings });
});

const intervalSchema = z.object({
  start: z.string(),
  end: z.string(),
});

const putSchema = z.object({
  weeklyHours: z.record(z.string(), z.array(intervalSchema)).optional(),
  slotMinutes: z.number().optional(),
  bufferMinutes: z.number().optional(),
  minNoticeHours: z.number().optional(),
  maxDaysAhead: z.number().optional(),
  timezone: z.string().optional(),
  // O catálogo manda: um conector que não existe é recusado aqui, e o
  // serviço verifica de novo caso quem chamou não seja esta rota.
  connector: z
    .string()
    .refine((v) => (CONNECTOR_ORDER as readonly string[]).includes(v), {
      message: "Conector desconhecido",
    })
    .optional(),
  meetingLink: z.string().nullish(),
});

/**
 * Salva o que for possível: os inteiros fora da faixa são ajustados e os
 * intervalos mal escritos são descartados, em vez de derrubar o horário inteiro por
 * uma célula. O que é recusado é o que quebraria o motor depois: um
 * fuso horário que o runtime não conhece, ou um conector inexistente.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  try {
    const settings = await upsertSettings(session.organizationId, {
      ...body.data,
      // `undefined` = não foi tocado; `null` = foi esvaziado de propósito.
      meetingLink:
        body.data.meetingLink === undefined ? undefined : body.data.meetingLink,
    });
    return Response.json({ settings });
  } catch (err) {
    if (err instanceof CalendarSettingsError) {
      return apiError(422, "invalid_body", err.message);
    }
    throw err;
  }
});
