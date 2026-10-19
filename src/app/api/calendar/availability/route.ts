import { withAuth } from "@/lib/api";
import { dayIsoInTz, timeInTz, dayLabelInTz } from "@/lib/time/slots";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 015 — As janelas livres, para o operador.
 *
 * Diferentemente da superfície do bot, esta NÃO registra oferta: é a visão
 * de quem já está olhando a agenda e escolhe entre o que vê.
 *
 * Sem janelas, responde `{"slots":[]}` com 200: agenda cheia é uma resposta,
 * não um erro.
 */
export const GET = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const settings = await getSettings(session.organizationId);
  const now = new Date();
  const slots = await computeAvailability(session.organizationId, {
    fromISO: from && ISO_DATE.test(from) ? from : undefined,
    toISO: to && ISO_DATE.test(to) ? to : undefined,
    settings,
    now,
  });

  return Response.json({
    slots: slots.map((s) => ({
      ...s,
      dayIso: dayIsoInTz(new Date(s.startUtc), settings.timezone),
      dayLabel: dayLabelInTz(s.startUtc, settings.timezone, now),
      time: timeInTz(s.startUtc, settings.timezone),
    })),
  });
});
