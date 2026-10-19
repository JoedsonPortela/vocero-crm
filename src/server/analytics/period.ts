import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import {
  addDaysISO,
  isValidTimeZone,
  todayInTz,
  zonedWallClockToUtc,
} from "@/lib/time/slots";
import type { PeriodDto } from "@/lib/analytics";
import { DEFAULT_TIMEZONE } from "@/server/agenda/settings";

/**
 * 019 — O período consultado, resolvido no fuso do NEGÓCIO.
 *
 * Com cortes em UTC, tudo o que acontece depois das 18:00 no México cai no
 * dia seguinte: o dono compararia a sua segunda-feira com uma segunda-feira que não existe.
 * O fuso sai da agenda (`calendar_settings`), o mesmo que já decide o que
 * é "hoje" para os horários disponíveis; sem agenda, o padrão.
 *
 * Apoia-se em `lib/time/slots`, que a 015 já usa para o mesmo e está
 * testado: uma segunda forma de entender os fusos horários dentro do mesmo
 * repositório seria a receita para que duas telas não coincidissem em qual dia
 * é hoje.
 */

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FORMATO = "Fechas inválidas: usa el formato AAAA-MM-DD";

/** Intervalo em instantes UTC + seu equivalente do período anterior. */
export type ResolvedPeriod = {
  dto: PeriodDto;
  /** Início do primeiro dia local, em UTC. */
  start: Date;
  /** Fim EXCLUSIVO: o instante em que começa o dia seguinte ao `to`. */
  end: Date;
  previousStart: Date;
  previousEnd: Date;
  timezone: string;
};

export class PeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodError";
  }
}

export async function businessTimezone(organizationId: string): Promise<string> {
  const rows = await getDb()
    .select({ timezone: schema.calendarSettings.timezone })
    .from(schema.calendarSettings)
    .where(eq(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  const tz = rows[0]?.timezone;
  // Um fuso inválido guardado no banco não pode derrubar a tela inteira:
  // cai-se no padrão, que é o mesmo que faz a agenda.
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** Dias de diferença entre duas datas de calendário. */
export function daysApart(fromISO: string, toISO: string): number {
  return Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) /
      86_400_000
  );
}

function medianoche(isoDate: string, timezone: string): Date {
  const d = zonedWallClockToUtc(isoDate, "00:00", timezone);
  if (!d || Number.isNaN(d.getTime())) throw new PeriodError(FORMATO);
  return d;
}

/**
 * `from`/`to` são datas de calendário (`AAAA-MM-DD`) INCLUSIVAS. Ausentes, os
 * últimos 30 dias terminando hoje.
 */
export function resolvePeriod(input: {
  from?: string | null;
  to?: string | null;
  timezone: string;
  now?: Date;
}): ResolvedPeriod {
  const tz =
    input.timezone && isValidTimeZone(input.timezone)
      ? input.timezone
      : DEFAULT_TIMEZONE;
  const hoy = todayInTz(input.now ?? new Date(), tz);

  if (input.from && !ISO_DATE.test(input.from)) throw new PeriodError(FORMATO);
  if (input.to && !ISO_DATE.test(input.to)) throw new PeriodError(FORMATO);

  const to = input.to || hoy;
  const from = input.from || addDaysISO(to, -(DEFAULT_DAYS - 1));

  // "2026-02-31" passa no padrão e não é uma data.
  const valida = (d: string) =>
    new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (
    Number.isNaN(Date.parse(`${from}T00:00:00Z`)) ||
    Number.isNaN(Date.parse(`${to}T00:00:00Z`)) ||
    !valida(from) ||
    !valida(to)
  ) {
    throw new PeriodError(FORMATO);
  }
  if (daysApart(from, to) < 0) {
    throw new PeriodError("La fecha inicial va antes que la final");
  }

  const days = daysApart(from, to) + 1;
  if (days > MAX_DAYS) {
    throw new PeriodError(`El rango máximo es de ${MAX_DAYS} días`);
  }

  // O período anterior tem a MESMA duração e termina logo antes: assim a
  // comparação não mistura um mês de 30 dias com um de 31.
  const previousTo = addDaysISO(from, -1);
  const previousFrom = addDaysISO(previousTo, -(days - 1));

  // Intervalos com fim EXCLUSIVO: `< end` evita o clássico bug do último
  // milissegundo do dia, que é contado duas vezes ou se perde.
  const start = medianoche(from, tz);
  const end = medianoche(addDaysISO(to, 1), tz);

  return {
    dto: {
      from,
      to,
      previousFrom,
      previousTo,
      timezone: tz,
      // Mais de 92 dias em barras diárias é ilegível: agrupa-se por mês.
      granularity: days > 92 ? "month" : "day",
      days,
    },
    start,
    end,
    previousStart: medianoche(previousFrom, tz),
    previousEnd: start,
    timezone: tz,
  };
}

/** Resolve o período da URL lendo o fuso do negócio. */
export async function periodFromRequest(
  organizationId: string,
  url: URL,
  now?: Date
): Promise<ResolvedPeriod> {
  const timezone = await businessTimezone(organizationId);
  return resolvePeriod({
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    timezone,
    now,
  });
}

/** Mediana de uma lista de números; `null` se estiver vazia. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
