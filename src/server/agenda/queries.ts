import { asc, desc, eq, gte, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { DateRange } from "@/lib/time/calendar";
import { addDaysISO, partsInTz, zonedWallClockToUtc } from "@/lib/time/slots";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";

/** 015 — Listagem de agendamentos para a UI, com a hora no fuso do negócio. */

export type BookingListItem = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  source: "manual" | "ai";
  scheduledAtUtc: string;
  durationMinutes: number;
  date: string;
  time: string;
  weekday: string;
  contact: { id: string; name: string } | null;
  conversationId: string | null;
  /** Com qual conector nasceu a entrega deste agendamento. */
  connector: string | null;
  meetingLink: string | null;
  /** O provedor falhou ao criar a reunião: pode-se tentar de novo. */
  linkPending: boolean;
  isTest: boolean;
  notes: string | null;
};

/** Teto da listagem sem intervalo: o de sempre, que os roteiros E2E leem. */
export const LIST_LIMIT = 200;

/**
 * 215 — Teto de uma consulta por intervalo. Não é um limite do produto (92 dias
 * de um negócio com 30 agendamentos diários são 2 760): é o seguro contra uma
 * resposta de megas. Se for atingido, a resposta diz isso (`truncated`) em vez
 * de esconder agendamentos, como fazia o teto de 200.
 */
export const RANGE_LIMIT = 3000;

/**
 * Quanto a consulta por intervalo olha para trás. A API aceita bloqueios de
 * até 600 minutos: um que começou às 20:00 do dia anterior ao intervalo
 * continua ocupando a sua madrugada, e a grade precisa pintá-lo.
 */
const LOOKBACK_MS = 24 * 3_600_000;

type Row = {
  booking: typeof schema.booking.$inferSelect;
  contactId: string | null;
  contactName: string | null;
};

function baseQuery() {
  return getDb()
    .select({
      booking: schema.booking,
      contactId: schema.contact.id,
      contactName: schema.contact.name,
    })
    .from(schema.booking)
    .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id));
}

/** Os últimos 200 agendamentos: a listagem de sempre, para quem não pede intervalo. */
export async function listBookings(
  organizationId: string,
  settings?: CalendarSettings
): Promise<BookingListItem[]> {
  const resolved = settings ?? (await getSettings(organizationId));
  const rows = await baseQuery()
    .where(scoped(schema.booking.organizationId, organizationId))
    .orderBy(desc(schema.booking.scheduledAt))
    .limit(LIST_LIMIT);
  return rows.map((r) => toListItem(r, resolved.timezone));
}

/**
 * 215 — Os agendamentos que TOCAM um intervalo de dias no fuso do negócio, em ordem.
 *
 * `from`/`to` são datas de calendário inclusivas; o corte é feito à
 * meia-noite do negócio, não à de UTC (com cortes em UTC, o que acontece
 * depois das 18:00 no México cairia na coluna do dia seguinte).
 */
export async function listBookingsInRange(
  organizationId: string,
  range: DateRange,
  settings?: CalendarSettings
): Promise<{ bookings: BookingListItem[]; truncated: boolean }> {
  const resolved = settings ?? (await getSettings(organizationId));
  const tz = resolved.timezone;
  // Datas já validadas (`parseRangeQuery`): a conversão não pode falhar.
  const start = zonedWallClockToUtc(range.from, "00:00", tz)!;
  const end = zonedWallClockToUtc(addDaysISO(range.to, 1), "00:00", tz)!;

  const rows = await baseQuery()
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        gte(schema.booking.scheduledAt, new Date(start.getTime() - LOOKBACK_MS)),
        lt(schema.booking.scheduledAt, end)
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(RANGE_LIMIT);

  // Do que começou no dia anterior, só o que continua ocupando o intervalo.
  const inRange = rows.filter(
    (r) =>
      r.booking.scheduledAt.getTime() + r.booking.durationMinutes * 60_000 >
      start.getTime()
  );
  return {
    bookings: inRange.map((r) => toListItem(r, tz)),
    truncated: rows.length === RANGE_LIMIT,
  };
}

function toListItem(r: Row, timezone: string): BookingListItem {
  const scheduledAtUtc = r.booking.scheduledAt.toISOString();
  const parts = partsInTz(scheduledAtUtc, timezone);
  return {
    id: r.booking.id,
    kind: r.booking.kind,
    status: r.booking.status,
    source: r.booking.source,
    scheduledAtUtc,
    durationMinutes: r.booking.durationMinutes,
    date: parts.date,
    time: parts.time,
    weekday: parts.weekday,
    contact: r.contactId ? { id: r.contactId, name: r.contactName ?? "" } : null,
    conversationId: r.booking.conversationId,
    connector: r.booking.connector,
    meetingLink: r.booking.meetingLink,
    linkPending: r.booking.linkPending,
    isTest: r.booking.isTest,
    notes: r.booking.notes,
  };
}
