import { notFound, redirect } from "next/navigation";
import { BookingsClient } from "@/components/bookings/bookings-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { clampListTo, isCalendarView, isIsoDate } from "@/lib/time/calendar";
import { todayInTz } from "@/lib/time/slots";
import { agendaEnabled } from "@/server/agenda/flag";
import { getSettings } from "@/server/agenda/settings";

export const dynamic = "force-dynamic";

type Params = { vista?: string; fecha?: string; desde?: string; hasta?: string };

/**
 * 215 — Visões de calendário. A visão e a data ficam na URL
 * (`?vista=semana&fecha=2026-09-18`, ou `desde`/`hasta` na Lista) para que
 * recarregar ou compartilhar o link abra no mesmo lugar.
 *
 * "Hoje" é decidido aqui, no fuso horário do NEGÓCIO: o navegador de quem olha
 * pode estar em outro.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  // Sem a flag, esta tela não existe nesta instância.
  if (!agendaEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/login");

  const settings = await getSettings(session.organizationId);
  const params = await searchParams;
  const view = isCalendarView(params.vista) ? params.vista : null;
  const listFrom = isIsoDate(params.desde) ? params.desde : null;
  const date =
    view === "lista" && listFrom
      ? listFrom
      : isIsoDate(params.fecha)
        ? params.fecha
        : todayInTz(new Date(), settings.timezone);

  return (
    <BookingsClient
      initialView={view}
      initialDate={date}
      initialListTo={
        view === "lista" && isIsoDate(params.hasta)
          ? clampListTo(date, params.hasta)
          : null
      }
      timezone={settings.timezone}
      weeklyHours={settings.weeklyHours}
    />
  );
}
