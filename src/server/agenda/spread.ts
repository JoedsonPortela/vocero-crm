import {
  addDaysISO,
  dayIsoInTz,
  dayLabelInTz,
  timeInTz,
} from "@/lib/time/slots";
import type { AvailableSlot } from "@/server/agenda/availability";

/**
 * 015 — Distribuição de horários entre dias diferentes.
 *
 * Os N horários mais próximos quase sempre caem todos HOJE, e então quem
 * conduz a conversa não tem nada para oferecer quando o lead diz "e
 * na quinta?". Isto pega `perDay` por dia até completar `limit`, de modo que
 * a oferta cubra vários dias.
 *
 * O catálogo reservável é MAIS AMPLO que o menu exibido: são oferecidos
 * (e registrados) até `limit`, mesmo que o agente mostre três. Guardar só o
 * mostrado deixava o agente sem alternativas legítimas para aceitar.
 */

export type SpreadSlot = AvailableSlot & {
  /** Dia do slot no fuso do negócio (AAAA-MM-DD). */
  dayIso: string;
  /** O dia POR EXTENSO: "hoje quarta-feira 5 de agosto". */
  dayLabel: string;
  /** Só a hora: "10:00". */
  time: string;
};

export function spreadByDay(
  slots: AvailableSlot[],
  opts: { timezone: string; limit: number; perDay: number; now?: Date }
): SpreadSlot[] {
  const { timezone, limit, perDay } = opts;
  const now = opts.now ?? new Date();
  if (limit <= 0 || perDay <= 0) return [];

  const byDay = new Map<string, AvailableSlot[]>();
  for (const slot of slots) {
    const dayIso = dayIsoInTz(new Date(slot.startUtc), timezone);
    const bucket = byDay.get(dayIso);
    if (bucket) bucket.push(slot);
    else byDay.set(dayIso, [slot]);
  }

  // Os dias já vêm ordenados porque `slots` vem ordenado; o Map
  // mantém a ordem de inserção.
  const out: SpreadSlot[] = [];
  for (const [dayIso, daySlots] of byDay) {
    for (const slot of daySlots.slice(0, perDay)) {
      if (out.length >= limit) return out;
      out.push({
        ...slot,
        dayIso,
        dayLabel: dayLabelInTz(slot.startUtc, timezone, now),
        time: timeInTz(slot.startUtc, timezone),
      });
    }
  }
  return out;
}

/**
 * O que foi consultado de fato, para que quem oferece não invente «nesse dia não há
 * agenda» nem «só tenho de manhã».
 *
 * No teste de ponta a ponta com a Nea (set 2026), um cliente pediu «amanhã à
 * tarde» e o agente lhe ofereceu 10:00, 10:30 e 11:00 dizendo que na terça
 * só havia manhã, com a agenda livre das 12:00 às 18:30. A distribuição (três
 * horas por dia) não mentia; o que faltava era dizer até onde ela chegava, e
 * poder perguntar por um dia específico: `date` era ignorado.
 *
 * Portado da edição Cloud (002b7bc, `armarHuecos`), sem cérebros nem
 * tenant, com a janela `days` que só existe aqui.
 *
 * - `available`: há horários (com `date`, os daquele dia).
 * - `closed`: naquele dia o negócio não abre.
 * - `full`: abre, mas não sobra nada livre (ou já não dá o aviso mínimo).
 * - `past` / `beyond_horizon`: fora do que pode ser agendado.
 */
export type EstadoDelDia =
  | "available"
  | "closed"
  | "full"
  | "past"
  | "beyond_horizon";

export type ConsultaDeHuecos = {
  /** O dia pedido, ou null se for a distribuição de sempre. */
  date: string | null;
  /** Só com `date`. */
  status: EstadoDelDia | null;
  /**
   * Último dia REVISADO. Um dia posterior que não aparece não foi consultado — não
   * é que não tenha agenda. Com `date`, é esse mesmo dia.
   */
  coveredUntil: string | null;
  /** Último dia que pode ser agendado (hoje + `maxDaysAhead`). */
  horizonEnd: string;
  /** Na distribuição, quantas horas por dia no máximo. null com `date`. */
  perDay: number | null;
};

/** Quantas horas de UM dia são entregues, no máximo, ao perguntar por esse dia. */
export const HUECOS_POR_FECHA = 24;

/**
 * PURA: se um dia traz mais horários que o teto, escolhe `teto` distribuídos ao
 * longo de TODO o dia — o primeiro e o último incluídos — em vez dos
 * primeiros. Cortar pelo início era justamente o bug: tudo caía de manhã.
 * Abaixo do teto devolve a lista como está.
 */
export function aLoLargoDelDia<T>(slots: T[], tope: number): T[] {
  if (tope <= 0) return [];
  if (slots.length <= tope) return slots;
  if (tope === 1) return slots.slice(0, 1);
  // passo > 1 porque slots.length > teto: os índices arredondados não se repetem.
  const paso = (slots.length - 1) / (tope - 1);
  return Array.from({ length: tope }, (_, i) => slots[Math.round(i * paso)]!);
}

/**
 * PURA: os horários a oferecer e o quanto eles cobrem.
 *
 * `todos` são os livres do intervalo consultado (ordenados); `candidatosDelDia`,
 * quantos turnos esse dia tem no horário semanal, para distinguir fechado
 * de lotado. Com `date`, `limit`/`perDay`/`days` não se aplicam: devolve-se o dia
 * inteiro (até `HUECOS_POR_FECHA`, distribuídos ao longo do dia). Sem BD
 * nem relógio: tests/unit/agenda-huecos-por-fecha.test.ts.
 */
export function armarHuecos(input: {
  todos: AvailableSlot[];
  timezone: string;
  now: Date;
  maxDaysAhead: number;
  limit: number;
  perDay: number;
  /** Janela da distribuição em dias, hoje incluído. Sem ela, todo o horizonte. */
  days?: number;
  date?: string | null;
  candidatosDelDia?: number;
}): { slots: SpreadSlot[]; query: ConsultaDeHuecos } {
  const { timezone, now } = input;
  const hoy = dayIsoInTz(now, timezone);
  const horizonEnd = addDaysISO(hoy, input.maxDaysAhead);
  const diaDe = (s: AvailableSlot) => dayIsoInTz(new Date(s.startUtc), timezone);

  if (input.date) {
    const date = input.date;
    const base = { date, horizonEnd, perDay: null };
    if (date < hoy) {
      return { slots: [], query: { ...base, status: "past", coveredUntil: null } };
    }
    if (date > horizonEnd) {
      return {
        slots: [],
        query: { ...base, status: "beyond_horizon", coveredUntil: null },
      };
    }
    const delDia = aLoLargoDelDia(
      input.todos.filter((s) => diaDe(s) === date),
      HUECOS_POR_FECHA
    );
    const slots = spreadByDay(delDia, {
      timezone,
      limit: HUECOS_POR_FECHA,
      perDay: HUECOS_POR_FECHA,
      now,
    });
    const status: EstadoDelDia =
      slots.length > 0
        ? "available"
        : (input.candidatosDelDia ?? 0) === 0
          ? "closed"
          : "full";
    return { slots, query: { ...base, status, coveredUntil: date } };
  }

  // A janela se aplica ANTES da distribuição: dá os mesmos horários que distribuir
  // e depois recortar (os dias vêm em ordem), e assim se sabe o que foi revisado.
  const finDeVentana =
    input.days === undefined ? horizonEnd : addDaysISO(hoy, input.days - 1);
  const ventanaHasta = finDeVentana < horizonEnd ? finDeVentana : horizonEnd;
  const slots = spreadByDay(
    input.todos.filter((s) => {
      const dia = diaDe(s);
      return dia >= hoy && dia <= ventanaHasta;
    }),
    { timezone, limit: input.limit, perDay: input.perDay, now }
  );
  // Se a distribuição lotou, o que vem depois do último dia incluído não
  // foi revisado. Se não lotou, percorreu-se toda a janela.
  const lleno = slots.length >= input.limit;
  const ultimo = slots[slots.length - 1]?.dayIso;
  return {
    slots,
    query: {
      date: null,
      status: null,
      coveredUntil: lleno && ultimo ? ultimo : ventanaHasta,
      horizonEnd,
      perDay: input.perDay,
    },
  };
}

/** Os dias (AAAA-MM-DD) que têm algo para oferecer. Os ausentes NÃO. */
export function daysWithAgenda(slots: SpreadSlot[]): string[] {
  return [...new Set(slots.map((s) => s.dayIso))];
}
