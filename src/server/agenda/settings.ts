import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  DEFAULT_CONNECTOR,
  isConnectorId,
  type ConnectorId,
} from "@/lib/agenda-connectors";
import {
  isValidInterval,
  isValidTimeZone,
  WEEKDAYS,
  type Interval,
  type WeekdayKey,
} from "@/lib/time/slots";

/**
 * 015 — A configuração da agenda do negócio (uma por organização):
 * leitura com padrões e upsert normalizado.
 */

export type WeeklyHours = Partial<Record<WeekdayKey, Interval[]>>;

export const DEFAULT_TIMEZONE = "America/Mexico_City";

/** Seg-Sex 09:00-18:00 — ajusta-se em Configurações → Agenda. */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ start: "09:00", end: "18:00" }],
  tue: [{ start: "09:00", end: "18:00" }],
  wed: [{ start: "09:00", end: "18:00" }],
  thu: [{ start: "09:00", end: "18:00" }],
  fri: [{ start: "09:00", end: "18:00" }],
};

export type CalendarSettings = {
  weeklyHours: WeeklyHours;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  timezone: string;
  /** Como a reunião é entregue. */
  connector: ConnectorId;
  /** Sala fixa do conector `enlace-fijo`; null ⇒ agendamentos sem link. */
  meetingLink: string | null;
};

/** O que vê uma instância recém-ligada: útil sem configurar nada. */
export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 2,
  maxDaysAhead: 7,
  timezone: DEFAULT_TIMEZONE,
  connector: DEFAULT_CONNECTOR,
  meetingLink: null,
};

export const LIMITS = {
  slotMinutes: { min: 10, max: 240 },
  bufferMinutes: { min: 0, max: 120 },
  minNoticeHours: { min: 0, max: 72 },
  maxDaysAhead: { min: 1, max: 60 },
} as const;

export async function getSettings(
  organizationId: string
): Promise<CalendarSettings> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.calendarSettings)
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);

  const row = rows[0];
  // Sem linha: a instância recém-ligada já é utilizável.
  if (!row) return DEFAULT_CALENDAR_SETTINGS;

  return {
    weeklyHours: normalizeWeeklyHours(row.weeklyHours as WeeklyHours),
    slotMinutes: row.slotMinutes,
    bufferMinutes: row.bufferMinutes,
    minNoticeHours: row.minNoticeHours,
    maxDaysAhead: row.maxDaysAhead,
    timezone: row.timezone,
    // Um conector que não existe mais no código (p. ex. você vinha de um fork) não
    // pode deixar a agenda inútil: rebaixa-se para o soberano.
    connector: isConnectorId(row.connector) ? row.connector : DEFAULT_CONNECTOR,
    meetingLink: row.meetingLink,
  };
}

export class CalendarSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarSettingsError";
  }
}

/**
 * O que chega de fora, antes de normalizar: o horário e o conector vêm
 * soltos porque sua validação mora AQUI. Se o tipo estrito fosse exigido na
 * rota, cada chamador teria que fazer um cast — e um cast é justamente a
 * verificação que não acontece.
 */
export type CalendarSettingsInput = Partial<
  Omit<CalendarSettings, "weeklyHours" | "connector">
> & {
  weeklyHours?: unknown;
  connector?: string;
};

export async function upsertSettings(
  organizationId: string,
  input: CalendarSettingsInput
): Promise<CalendarSettings> {
  const current = await getSettings(organizationId);

  const timezone = input.timezone ?? current.timezone;
  // Um fuso desconhecido quebraria o motor inteiro: rejeita-se ao salvar.
  if (!isValidTimeZone(timezone)) {
    throw new CalendarSettingsError(`Zona horaria desconocida: ${timezone}`);
  }

  const connector = input.connector ?? current.connector;
  if (!isConnectorId(connector)) {
    throw new CalendarSettingsError(`Conector desconocido: ${connector}`);
  }

  const next: CalendarSettings = {
    weeklyHours: normalizeWeeklyHours(
      input.weeklyHours !== undefined ? input.weeklyHours : current.weeklyHours
    ),
    slotMinutes: clampInt(
      input.slotMinutes ?? current.slotMinutes,
      LIMITS.slotMinutes.min,
      LIMITS.slotMinutes.max
    ),
    bufferMinutes: clampInt(
      input.bufferMinutes ?? current.bufferMinutes,
      LIMITS.bufferMinutes.min,
      LIMITS.bufferMinutes.max
    ),
    minNoticeHours: clampInt(
      input.minNoticeHours ?? current.minNoticeHours,
      LIMITS.minNoticeHours.min,
      LIMITS.minNoticeHours.max
    ),
    maxDaysAhead: clampInt(
      input.maxDaysAhead ?? current.maxDaysAhead,
      LIMITS.maxDaysAhead.min,
      LIMITS.maxDaysAhead.max
    ),
    timezone,
    connector,
    meetingLink: normalizeLink(
      input.meetingLink !== undefined ? input.meetingLink : current.meetingLink
    ),
  };

  const db = getDb();
  const values = {
    weeklyHours: next.weeklyHours,
    slotMinutes: next.slotMinutes,
    bufferMinutes: next.bufferMinutes,
    minNoticeHours: next.minNoticeHours,
    maxDaysAhead: next.maxDaysAhead,
    timezone: next.timezone,
    connector: next.connector,
    meetingLink: next.meetingLink,
  };
  await db
    .insert(schema.calendarSettings)
    .values({
      id: newId("calendarSettings"),
      organizationId,
      ...values,
    })
    .onConflictDoUpdate({
      target: schema.calendarSettings.organizationId,
      set: { ...values, updatedAt: new Date() },
    });

  return next;
}

/**
 * Descarta intervalos inválidos e dias vazios (dia fechado) e ordena por hora
 * de início. Prefere-se limpar a rejeitar: um dia mal escrito não deve derrubar
 * o salvamento completo do horário.
 */
export function normalizeWeeklyHours(input: unknown): WeeklyHours {
  const out: WeeklyHours = {};
  if (typeof input !== "object" || input === null) return out;
  const source = input as Record<string, unknown>;
  for (const day of WEEKDAYS) {
    const intervals = source[day];
    if (!Array.isArray(intervals)) continue;
    const valid = intervals
      .filter(isValidInterval)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (valid.length > 0) out[day] = valid;
  }
  return out;
}

/** String vazia ou espaços ⇒ null (o campo é opcional de fato). */
function normalizeLink(link: string | null | undefined): string | null {
  const trimmed = (link ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
