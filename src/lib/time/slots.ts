/**
 * 015 — Helpers puros de tempo para o motor de agenda.
 *
 * Regra de ouro: os instantes vivem em UTC. O fuso horário do negócio só
 * serve para (a) expandir o horário semanal, que é hora de PAREDE, e (b)
 * rotular para o cliente.
 *
 * Sem dependências: tudo se resolve com o `Intl` da plataforma, que já traz
 * o banco de dados de fusos (verificado também no contêiner Alpine de
 * produção: 418 fusos e formato es-MX correto). Ver
 * specs/015-motor-agenda-universal/research.md D1.
 */

export type Interval = { start: string; end: string }; // "HH:mm" hora de parede

export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type SlotUtc = { startUtc: string; endUtc: string };

export const WEEKDAYS: WeekdayKey[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidInterval(iv: unknown): iv is Interval {
  if (typeof iv !== "object" || iv === null) return false;
  const { start, end } = iv as { start?: unknown; end?: unknown };
  return (
    typeof start === "string" &&
    typeof end === "string" &&
    HHMM.test(start) &&
    HHMM.test(end) &&
    start < end
  );
}

/** O runtime conhece este fuso IANA? Evita gravar lixo que quebre o motor. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Defasagem do fuso (minutos a leste de UTC) EM um instante dado. Formata-se
 * o instante no fuso e lê-se o resultado como se fosse UTC: a
 * diferença é a defasagem vigente ali, com o horário de verão já aplicado.
 */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    // O Intl pode devolver "24" à meia-noite em alguns ambientes.
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second)
  );
  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Hora de parede (`YYYY-MM-DD` + `HH:mm`) em um fuso → instante UTC.
 *
 * Duas passadas: a primeira estima a defasagem, a segunda a corrige quando a
 * mudança de horário cai justo naquele ponto. Numa hora inexistente (salto de
 * primavera) devolve um instante real usando a defasagem anterior; numa hora
 * ambígua (recuo) escolhe a primeira ocorrência. Nunca lança exceção.
 */
export function zonedWallClockToUtc(
  dayISODate: string,
  hhmm: string,
  tz: string
): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayISODate);
  if (!day || !HHMM.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(
    Number(day[1]),
    Number(day[2]) - 1,
    Number(day[3]),
    h,
    m
  );
  const first = tzOffsetMinutes(new Date(guess), tz);
  let ts = guess - first * 60_000;
  const second = tzOffsetMinutes(new Date(ts), tz);
  if (second !== first) ts = guess - second * 60_000;
  return new Date(ts);
}

/** Dia da semana (mon..sun) de uma data ISO em um fuso dado. */
export function weekdayKeyOf(dayISODate: string, tz: string): WeekdayKey | null {
  // Meio-dia: nenhuma defasagem do mundo o empurra para o dia vizinho.
  const noon = zonedWallClockToUtc(dayISODate, "12:00", tz);
  if (!noon) return null;
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  })
    .format(noon)
    .toLowerCase();
  const key = WEEKDAYS.find((d) => short.startsWith(d));
  return key ?? null;
}

/** Datas ISO (YYYY-MM-DD) de cada dia do intervalo [from, to] inclusive. */
export function eachDateInRange(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return out;
  // Limite defensivo: a janela máxima configurável é de 60 dias.
  for (let t = from, i = 0; t <= to && i < 400; t += 86_400_000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Data ISO (YYYY-MM-DD) de um instante no fuso do negócio. */
export function dayIsoInTz(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/** Data ISO de "hoje" no fuso do negócio. */
export function todayInTz(now: Date, tz: string): string {
  return dayIsoInTz(now, tz);
}

/** Soma dias a uma data ISO (sem fuso: é aritmética de calendário). */
export function addDaysISO(dayISODate: string, days: number): string {
  const ts = Date.parse(`${dayISODate}T00:00:00Z`);
  if (Number.isNaN(ts)) return dayISODate;
  return new Date(ts + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Expande os intervalos úteis de UM dia (hora de parede no tz) em slots UTC.
 * Avança `slot + buffer` a cada passo e só emite o slot se ele CABER inteiro
 * dentro do intervalo.
 */
export function expandWorkingDayToUtc(
  dayISODate: string,
  intervals: Interval[],
  tz: string,
  slotMinutes: number,
  bufferMinutes: number
): SlotUtc[] {
  const out: SlotUtc[] = [];
  const step = slotMinutes + Math.max(0, bufferMinutes);
  if (slotMinutes <= 0 || step <= 0) return out;

  for (const iv of intervals) {
    const start = zonedWallClockToUtc(dayISODate, iv.start, tz);
    const end = zonedWallClockToUtc(dayISODate, iv.end, tz);
    if (!start || !end || end <= start) continue;

    for (
      let t = start.getTime(), guard = 0;
      t + slotMinutes * 60_000 <= end.getTime() && guard < 500;
      t += step * 60_000, guard++
    ) {
      out.push({
        startUtc: new Date(t).toISOString(),
        endUtc: new Date(t + slotMinutes * 60_000).toISOString(),
      });
    }
  }
  return out;
}

/** Sobrepõem-se [aStart,aEnd) e [bStart,bEnd)? */
export function overlaps(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  return (
    Date.parse(aStart) < Date.parse(bEnd) &&
    Date.parse(bStart) < Date.parse(aEnd)
  );
}

/** Rótulo legível no fuso do negócio: "mié 5 ago, 10:00". */
export function labelInTz(startUtc: string, tz: string): string {
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekday = (map.weekday ?? "").replace(/\.$/, "");
  const month = (map.month ?? "").replace(/\.$/, "");
  return `${weekday} ${map.day} ${month}, ${map.hour}:${map.minute}`;
}

/** Só a hora no fuso do negócio: "10:00". */
export function timeInTz(startUtc: string, tz: string): string {
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * O dia POR EXTENSO, com "hoje"/"amanhã" quando cabe: "hoy viernes 7 de
 * agosto".
 *
 * Existe porque o rótulo curto não basta: em produção do fork um lead
 * respondeu "10:30, de manhã" a uma oferta de HOJE e o agendamento foi feito no dia
 * errado. Quem oferece precisa poder dizer o dia completo.
 */
export function dayLabelInTz(startUtc: string, tz: string, now?: Date): string {
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return "";
  const dayIso = dayIsoInTz(d, tz);
  const todayIso = dayIsoInTz(now ?? new Date(), tz);

  let prefijo = "";
  if (dayIso === todayIso) prefijo = "hoje ";
  else if (dayIso === addDaysISO(todayIso, 1)) prefijo = "amanhã ";

  const cuerpo = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
  return `${prefijo}${cuerpo}`;
}

/**
 * Os formatadores de `partsInTz`, um por fuso. Construir um
 * `Intl.DateTimeFormat` custa muito mais do que usá-lo, e o calendário de Agendamentos
 * (215) formata até 3 000 agendamentos por consulta: três construções por agendamento
 * seriam segundos de CPU por resposta.
 */
const PARTS_FORMATS = new Map<
  string,
  { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat }
>();

function partsFormats(tz: string) {
  let f = PARTS_FORMATS.get(tz);
  if (!f) {
    const mk = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("pt-BR", { timeZone: tz, ...opts });
    f = {
      date: mk({ day: "numeric", month: "short", year: "numeric" }),
      time: mk({ hour: "2-digit", minute: "2-digit", hour12: false }),
      weekday: mk({ weekday: "long" }),
    };
    PARTS_FORMATS.set(tz, f);
  }
  return f;
}

/** Partes separadas para a tabela de Agendamentos. */
export function partsInTz(
  startUtc: string,
  tz: string
): { date: string; time: string; weekday: string } {
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return { date: "", time: "", weekday: "" };
  const f = partsFormats(tz);
  return {
    date: f.date.format(d),
    time: f.time.format(d),
    weekday: f.weekday.format(d),
  };
}
