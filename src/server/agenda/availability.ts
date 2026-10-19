import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  addDaysISO,
  eachDateInRange,
  expandWorkingDayToUtc,
  labelInTz,
  overlaps,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";

/**
 * 015 — Motor de disponibilidade:
 *   horário semanal do negócio − agendamentos ativos − bloqueios manuais.
 *
 * Limitação v1 documentada (Constituição VII): NÃO lê calendários externos.
 * É uma decisão, não um esquecimento: colocar o provedor neste caminho acoplaria a sua
 * latência e suas quedas à tela mais usada. Os compromissos de fora
 * são refletidos com bloqueios manuais.
 */

export type AvailableSlot = SlotUtc & { label: string };

/**
 * PURA: expande o horário semanal em slots candidatos em UTC. Sem BD, sem
 * relógio — testa-se sozinha (tests/unit/availability.test.ts).
 */
export function buildCandidateSlots(
  settings: CalendarSettings,
  fromISO: string,
  toISO: string
): SlotUtc[] {
  const tz = settings.timezone;
  const candidates: SlotUtc[] = [];
  for (const date of eachDateInRange(fromISO, toISO)) {
    const weekday = weekdayKeyOf(date, tz);
    if (!weekday) continue;
    const intervals = settings.weeklyHours[weekday] ?? [];
    if (intervals.length === 0) continue; // día cerrado
    candidates.push(
      ...expandWorkingDayToUtc(
        date,
        intervals,
        tz,
        settings.slotMinutes,
        settings.bufferMinutes
      )
    );
  }
  return candidates;
}

/**
 * PURA: descarta o que já passou (com aviso mínimo) e o que se sobrepõe a algo
 * ocupado, ordena e rotula.
 */
export function filterFreeSlots(
  candidates: SlotUtc[],
  busy: SlotUtc[],
  opts: { now: Date; minNoticeHours: number; timezone: string }
): AvailableSlot[] {
  const minStartMs = opts.now.getTime() + opts.minNoticeHours * 3_600_000;
  return candidates
    .filter((c) => Date.parse(c.startUtc) >= minStartMs)
    .filter(
      (c) =>
        !busy.some((b) => overlaps(c.startUtc, c.endUtc, b.startUtc, b.endUtc))
    )
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))
    .map((c) => ({ ...c, label: labelInTz(c.startUtc, opts.timezone) }));
}

export async function computeAvailability(
  organizationId: string,
  opts?: {
    fromISO?: string;
    toISO?: string;
    excludeBookingId?: string;
    now?: Date;
    settings?: CalendarSettings;
  }
): Promise<AvailableSlot[]> {
  const settings = opts?.settings ?? (await getSettings(organizationId));
  const now = opts?.now ?? new Date();
  const tz = settings.timezone;

  const from = opts?.fromISO ?? todayInTz(now, tz);
  const to = opts?.toISO ?? addDaysISO(from, settings.maxDaysAhead);

  const candidates = buildCandidateSlots(settings, from, to);
  if (candidates.length === 0) return [];

  const busy = await getBusyIntervals(organizationId, {
    fromUtc: zonedWallClockToUtc(from, "00:00", tz) ?? new Date(0),
    toUtc:
      zonedWallClockToUtc(addDaysISO(to, 1), "00:00", tz) ??
      new Date(now.getTime() + 86_400_000 * 61),
    excludeBookingId: opts?.excludeBookingId,
  });

  return filterFreeSlots(candidates, busy, {
    now,
    minNoticeHours: settings.minNoticeHours,
    timezone: tz,
  });
}

/**
 * Revalida que um instante concreto continue livre. Chama-se AO CONFIRMAR, nunca
 * ao ofertar. `excludeBookingId` permite reagendar sem que o próprio
 * agendamento se bloqueie a si mesmo.
 *
 * Recalcula só ±1 dia em torno do instante pedido.
 *
 * ATENÇÃO: isto reduz a janela da corrida, não a fecha — entre este SELECT
 * e o INSERT cabe outra confirmação. Quem fecha de verdade é o índice
 * único parcial de `booking` (research D7); isto existe para dar uma resposta
 * útil (com alternativas) no caso normal.
 */
export async function findSlot(
  organizationId: string,
  whenISO: string,
  opts?: { excludeBookingId?: string; now?: Date; settings?: CalendarSettings }
): Promise<AvailableSlot | null> {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;

  const settings = opts?.settings ?? (await getSettings(organizationId));
  const dayInTz = todayInTz(new Date(target), settings.timezone);

  const slots = await computeAvailability(organizationId, {
    fromISO: addDaysISO(dayInTz, -1),
    toISO: addDaysISO(dayInTz, 1),
    excludeBookingId: opts?.excludeBookingId,
    now: opts?.now,
    settings,
  });
  return slots.find((s) => Date.parse(s.startUtc) === target) ?? null;
}

async function getBusyIntervals(
  organizationId: string,
  input: { fromUtc: Date; toUtc: Date; excludeBookingId?: string }
): Promise<SlotUtc[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.booking.id,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        and(
          // Cancelados e no-show liberam o horário.
          inArray(schema.booking.status, ["agendada", "realizada"]),
          // Sandbox: um agendamento de teste não consome a agenda real.
          eq(schema.booking.isTest, false),
          gte(schema.booking.scheduledAt, input.fromUtc),
          lte(schema.booking.scheduledAt, input.toUtc)
        )
      )
    );

  return rows
    .filter((r) => r.id !== input.excludeBookingId)
    .map((r) => ({
      startUtc: r.scheduledAt.toISOString(),
      endUtc: new Date(
        r.scheduledAt.getTime() + r.durationMinutes * 60_000
      ).toISOString(),
    }));
}
