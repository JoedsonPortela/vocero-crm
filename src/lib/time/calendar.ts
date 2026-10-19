import { addDaysISO, tzOffsetMinutes, WEEKDAYS, zonedWallClockToUtc, type Interval, type WeekdayKey } from "@/lib/time/slots";

/**
 * 215 — Aritmética do calendário de Agendamentos: quais dias são vistos em cada visão, como
 * se chama esse intervalo e em qual hora de parede cai cada agendamento.
 *
 * Duas regras, as mesmas de `slots.ts`:
 * 1. As DATAS (`AAAA-MM-DD`) são de calendário, sem fuso: somam-se em UTC e
 *    não tropeçam no horário de verão.
 * 2. Os INSTANTES são desenhados no fuso do NEGÓCIO, não no do navegador:
 *    é a hora em que a IA ofereceu o horário e a que o cliente recebeu.
 *
 * Sem `Intl.formatRange` para os rótulos: a sua saída muda entre a ICU do
 * Node e a de cada navegador ("sep" / "sept", traços diferentes), e um
 * rótulo que não pode ser fixado num teste acaba dizendo outra coisa.
 */

export type CalendarView = "dia" | "semana" | "mes" | "lista";

export const CALENDAR_VIEWS: readonly CalendarView[] = ["dia", "semana", "mes", "lista"];

/** Dias que a Lista abrange se ninguém escolheu outro intervalo. */
export const LIST_DEFAULT_DAYS = 30;

/**
 * Intervalo máximo que aceita `GET /api/bookings`: um trimestre. A visão de mês
 * pede 42 dias; a Lista, o que a pessoa escolher até este teto.
 */
export const MAX_RANGE_DAYS = 92;

export type DateRange = { from: string; to: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre",
];
const MONTHS_SHORT = [
  "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic",
];
/** De segunda a domingo, como `WEEKDAYS` e como o horário de Ajustes → Agenda. */
const WEEKDAYS_LONG = [
  "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo",
];
const WEEKDAYS_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

export function isCalendarView(v: unknown): v is CalendarView {
  return typeof v === "string" && (CALENDAR_VIEWS as readonly string[]).includes(v);
}

/**
 * É uma data de calendário que existe? `Date.parse("2026-02-31")` a aceita
 * e a converte em 3 de março; aqui se exige que a data volte igual.
 */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

/** Dias entre duas datas de calendário (`to - from`). */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000
  );
}

/** 0 = segunda … 6 = domingo. */
export function weekdayIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function weekdayKeyOfDate(iso: string): WeekdayKey {
  return WEEKDAYS[weekdayIndex(iso)]!;
}

/** A segunda-feira da semana dessa data. */
export function startOfWeek(iso: string): string {
  return addDaysISO(iso, -weekdayIndex(iso));
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Primeiro dia do mês `n` meses antes ou depois. */
export function addMonths(iso: string, n: number): string {
  const { y, m } = parts(iso);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

function endOfMonth(iso: string): string {
  return addDaysISO(addMonths(iso, 1), -1);
}

/**
 * Os dias que se veem. A semana vai de segunda a domingo; o mês, da semana
 * que contém o dia 1 à que contém o último (4 a 6 linhas, como no Google).
 */
export function visibleRange(
  view: CalendarView,
  anchor: string,
  listTo?: string | null
): DateRange {
  switch (view) {
    case "dia":
      return { from: anchor, to: anchor };
    case "semana": {
      const from = startOfWeek(anchor);
      return { from, to: addDaysISO(from, 6) };
    }
    case "mes": {
      const first = startOfMonth(anchor);
      return {
        from: startOfWeek(first),
        to: addDaysISO(startOfWeek(endOfMonth(first)), 6),
      };
    }
    case "lista":
      return { from: anchor, to: clampListTo(anchor, listTo) };
  }
}

/**
 * O fim da Lista, dentro do que a API aceita: nunca antes do início
 * nem além de `MAX_RANGE_DAYS`.
 */
export function clampListTo(from: string, to?: string | null): string {
  if (!isIsoDate(to)) return addDaysISO(from, LIST_DEFAULT_DAYS - 1);
  const span = daysBetween(from, to);
  if (span < 0) return from;
  if (span > MAX_RANGE_DAYS - 1) return addDaysISO(from, MAX_RANGE_DAYS - 1);
  return to;
}

/** Cada data do intervalo, inclusive. */
export function datesOf(range: DateRange): string[] {
  const n = daysBetween(range.from, range.to);
  return Array.from({ length: Math.max(0, n + 1) }, (_, i) => addDaysISO(range.from, i));
}

/** Linhas de 7 dias da visão de mês. */
export function monthWeeks(anchor: string): string[][] {
  const days = datesOf(visibleRange("mes", anchor));
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/**
 * Para onde leva o «‹ ›». Na Lista desloca-se pelo seu próprio tamanho, então
 * também devolve o novo fim.
 */
export function shiftRange(
  view: CalendarView,
  anchor: string,
  dir: 1 | -1,
  listTo?: string | null
): { anchor: string; listTo: string | null } {
  switch (view) {
    case "dia":
      return { anchor: addDaysISO(anchor, dir), listTo: null };
    case "semana":
      return { anchor: addDaysISO(anchor, 7 * dir), listTo: null };
    case "mes":
      return { anchor: addMonths(anchor, dir), listTo: null };
    case "lista": {
      const to = clampListTo(anchor, listTo);
      const span = daysBetween(anchor, to) + 1;
      return {
        anchor: addDaysISO(anchor, span * dir),
        listTo: addDaysISO(to, span * dir),
      };
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "18 de sep de 2026", com o ano só se for pedido. */
function shortDate(iso: string, withYear: boolean, withMonth = true): string {
  const { y, m, d } = parts(iso);
  const month = withMonth ? ` de ${MONTHS_SHORT[m - 1]}` : "";
  return `${d}${month}${withYear ? ` de ${y}` : ""}`;
}

/**
 * «14 – 20 de sep de 2026» · «28 de sep – 4 de oct de 2026» ·
 * «29 de dic de 2025 – 4 de ene de 2026»: o mesmo que o Google escreve.
 */
export function spanLabel(range: DateRange): string {
  if (range.from === range.to) return shortDate(range.from, true);
  const a = parts(range.from);
  const b = parts(range.to);
  if (a.y !== b.y) return `${shortDate(range.from, true)} – ${shortDate(range.to, true)}`;
  if (a.m !== b.m) return `${shortDate(range.from, false)} – ${shortDate(range.to, true)}`;
  return `${a.d} – ${shortDate(range.to, true)}`;
}

/** O que diz a barra: o dia, a semana, o mês ou o intervalo da Lista. */
export function rangeLabel(view: CalendarView, anchor: string, listTo?: string | null): string {
  switch (view) {
    case "dia":
      return capitalize(`${longDayLabel(anchor)} de ${parts(anchor).y}`);
    case "semana":
      return spanLabel(visibleRange("semana", anchor));
    case "mes": {
      const { y, m } = parts(anchor);
      return capitalize(`${MONTHS[m - 1]} de ${y}`);
    }
    case "lista":
      return spanLabel(visibleRange("lista", anchor, listTo));
  }
}

/** "viernes, 18 de septiembre". */
export function longDayLabel(iso: string): string {
  const { m, d } = parts(iso);
  return `${WEEKDAYS_LONG[weekdayIndex(iso)]}, ${d} de ${MONTHS[m - 1]}`;
}

/** Cabeçalho de coluna: "vie" e 18. */
export function dayHeading(iso: string): { weekday: string; day: number; month: string } {
  const { m, d } = parts(iso);
  return { weekday: WEEKDAYS_SHORT[weekdayIndex(iso)]!, day: d, month: MONTHS_SHORT[m - 1]! };
}

export function weekdayShortNames(): readonly string[] {
  return WEEKDAYS_SHORT;
}

/* ------------------------------------------------------------------ fuso */

const WALL_CLOCK = new Map<string, Intl.DateTimeFormat>();

function wallClockFormat(tz: string): Intl.DateTimeFormat {
  let f = WALL_CLOCK.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    WALL_CLOCK.set(tz, f);
  }
  return f;
}

/** Dia e minuto do dia (0–1439) de um instante, no fuso dado. */
export function wallClock(instant: Date | string, tz: string): { day: string; minutes: number } {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const map: Record<string, string> = {};
  for (const p of wallClockFormat(tz).formatToParts(date)) map[p.type] = p.value;
  return {
    day: `${map.year}-${map.month}-${map.day}`,
    // Alguns motores devolvem "24" à meia-noite mesmo com h23.
    minutes: (Number(map.hour) % 24) * 60 + Number(map.minute),
  };
}

/** "10:00". */
export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export type DaySegment = {
  day: string;
  /** Minuto do dia em que começa o trecho (0–1439). */
  startMin: number;
  /** Minuto em que termina (1–1440). */
  endMin: number;
  /** O trecho continua de um dia anterior / segue para o seguinte. */
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/**
 * Os trechos de um agendamento na grade: um por dia. Um agendamento que cruza a
 * meia-noite é partido em dois, como no Google, em vez de sair da coluna.
 */
export function bookingSegments(
  startUtc: string,
  durationMinutes: number,
  tz: string
): DaySegment[] {
  const startMs = Date.parse(startUtc);
  if (Number.isNaN(startMs)) return [];
  const duration = Math.max(1, durationMinutes);
  const start = wallClock(new Date(startMs), tz);
  const end = wallClock(new Date(startMs + duration * 60_000), tz);

  if (end.day === start.day) {
    // No recuo do horário de verão a hora de parede do fim pode
    // ficar ANTES do início; é desenhado com a sua duração real.
    const endMin =
      end.minutes > start.minutes ? end.minutes : Math.min(1440, start.minutes + duration);
    return [
      { day: start.day, startMin: start.minutes, endMin, continuesBefore: false, continuesAfter: false },
    ];
  }

  const out: DaySegment[] = [
    { day: start.day, startMin: start.minutes, endMin: 1440, continuesBefore: false, continuesAfter: true },
  ];
  // Limite defensivo: um agendamento não dura semanas.
  for (let day = addDaysISO(start.day, 1), i = 0; day < end.day && i < 7; day = addDaysISO(day, 1), i++) {
    out.push({ day, startMin: 0, endMin: 1440, continuesBefore: true, continuesAfter: true });
  }
  if (end.minutes > 0) {
    out.push({ day: end.day, startMin: 0, endMin: end.minutes, continuesBefore: true, continuesAfter: false });
  } else {
    out[out.length - 1]!.continuesAfter = false;
  }
  return out;
}

/**
 * Divide a largura entre o que se sobrepõe. Cada grupo de agendamentos que se tocam
 * entre si compartilha colunas; o agendamento vai na primeira coluna livre.
 */
export function layoutOverlaps<T extends { startMin: number; endMin: number }>(
  items: T[]
): (T & { col: number; cols: number })[] {
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - b.startMin - (a.endMin - a.startMin)
  );
  const out: (T & { col: number; cols: number })[] = [];
  let group: (T & { col: number; cols: number })[] = [];
  let columnsEnd: number[] = [];
  let groupEnd = -1;

  const closeGroup = () => {
    for (const g of group) g.cols = columnsEnd.length;
    out.push(...group);
    group = [];
    columnsEnd = [];
  };

  for (const item of sorted) {
    if (group.length > 0 && item.startMin >= groupEnd) closeGroup();
    let col = columnsEnd.findIndex((end) => end <= item.startMin);
    if (col === -1) {
      col = columnsEnd.length;
      columnsEnd.push(item.endMin);
    } else {
      columnsEnd[col] = item.endMin;
    }
    group.push({ ...item, col, cols: 1 });
    groupEnd = group.length === 1 ? item.endMin : Math.max(groupEnd, item.endMin);
  }
  if (group.length > 0) closeGroup();
  return out;
}

/** Trechos úteis desse dia conforme o horário semanal, em minutos. */
export function workingBands(
  weeklyHours: Partial<Record<WeekdayKey, Interval[]>>,
  iso: string
): { startMin: number; endMin: number }[] {
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number) as [number, number];
    return h * 60 + m;
  };
  return (weeklyHours[weekdayKeyOfDate(iso)] ?? [])
    .map((iv) => ({ startMin: toMin(iv.start), endMin: toMin(iv.end) }))
    .filter((b) => b.endMin > b.startMin)
    .sort((a, b) => a.startMin - b.startMin);
}

/** O que NÃO é útil nesse dia: é sombreado. Um dia fechado é inteiro. */
export function offHoursBands(
  weeklyHours: Partial<Record<WeekdayKey, Interval[]>>,
  iso: string
): { startMin: number; endMin: number }[] {
  const out: { startMin: number; endMin: number }[] = [];
  let cursor = 0;
  for (const b of workingBands(weeklyHours, iso)) {
    if (b.startMin > cursor) out.push({ startMin: cursor, endMin: b.startMin });
    cursor = Math.max(cursor, b.endMin);
  }
  if (cursor < 1440) out.push({ startMin: cursor, endMin: 1440 });
  return out;
}

/** "GMT-6", "GMT+5:30", "GMT": a defasagem do fuso do negócio agora. */
export function tzOffsetLabel(tz: string, at: Date = new Date()): string {
  // `tzOffsetMinutes` compara com um instante sem milissegundos: com o
  // relógio real sai "-359.99…" e o canto dizia "GMT-6:0.0103…".
  const offset = Math.round(tzOffsetMinutes(at, tz));
  if (offset === 0) return "GMT";
  const sign = offset > 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/* -------------------------------------------------------------- consulta */

export type RangeQuery =
  | { ok: true; range: DateRange | null }
  | { ok: false; message: string };

/**
 * `?from=&to=` de `GET /api/bookings`. Ausentes os dois, a lista de sempre;
 * apenas um, uma data que não existe, invertida ou mais de `MAX_RANGE_DAYS`, 422.
 */
export function parseRangeQuery(from: string | null, to: string | null): RangeQuery {
  if (!from && !to) return { ok: true, range: null };
  if (!from || !to) {
    return { ok: false, message: "Pide el rango con from y to juntos (AAAA-MM-DD)" };
  }
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return { ok: false, message: "Fechas inválidas: usa el formato AAAA-MM-DD" };
  }
  const span = daysBetween(from, to);
  if (span < 0) return { ok: false, message: "La fecha inicial va antes que la final" };
  if (span + 1 > MAX_RANGE_DAYS) {
    return { ok: false, message: `El rango máximo es de ${MAX_RANGE_DAYS} días` };
  }
  return { ok: true, range: { from, to } };
}

/* ------------------------------------------------ bloqueio e reagendamento */

/**
 * O instante UTC de um bloqueio pedido como dia + hora DO NEGÓCIO.
 *
 * Antes a tela fazia `new Date(valorDeDatetimeLocal)`, que lê a hora no
 * fuso do NAVEGADOR: um dono em viagem (ou um colaborador em outro fuso)
 * bloqueava as 15:00 do seu relógio, não as do negócio. Aqui o fuso é
 * explícito e o navegador não opina. `null` se o dia ou a hora não existirem.
 */
export function blockStartUtc(day: string, time: string, tz: string): string | null {
  if (!isIsoDate(day)) return null;
  const instant = zonedWallClockToUtc(day, time, tz);
  return instant ? instant.toISOString() : null;
}

export type DaySlot = { startUtc: string; dayIso: string; time: string };

/**
 * Os horários livres agrupados por dia, em ordem e SEM cortar: reagendar
 * oferece toda a janela do negócio (antes, os 12 primeiros).
 */
export function groupSlotsByDay<T extends DaySlot>(slots: readonly T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const s of slots) {
    const list = map.get(s.dayIso);
    if (list) list.push(s);
    else map.set(s.dayIso, [s]);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * O que é desenhado no calendário. As canceladas e os agendamentos do Laboratório
 * (`isTest`) ficam ocultos por padrão: uma cancelada já não ocupa o horário e
 * um de teste nunca o ocupou (o motor não o conta como ocupação).
 */
export function calendarVisible<T extends { status: string; isTest: boolean }>(
  bookings: readonly T[],
  opts: { showCancelled: boolean; showTests: boolean }
): T[] {
  return bookings.filter(
    (b) => (opts.showCancelled || b.status !== "cancelada") && (opts.showTests || !b.isTest)
  );
}

/**
 * Junta uma rajada de avisos em UMA chamada: a IA que agenda emite vários
 * eventos seguidos e cada um pedia tudo de novo.
 */
export function coalesce(fn: () => void, ms: number): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
