import { describe, expect, it } from "vitest";
import {
  buildCandidateSlots,
  filterFreeSlots,
} from "@/server/agenda/availability";
import {
  DEFAULT_CALENDAR_SETTINGS,
  normalizeWeeklyHours,
  type CalendarSettings,
} from "@/server/agenda/settings";
import { daysWithAgenda, spreadByDay } from "@/server/agenda/spread";

/** 015 — O motor: horário − ocupado, com aviso mínimo. Sem BD nem relógio real. */

const MX = "America/Mexico_City";

function settings(over: Partial<CalendarSettings> = {}): CalendarSettings {
  return { ...DEFAULT_CALENDAR_SETTINGS, ...over };
}

describe("buildCandidateSlots", () => {
  it("solo genera slots en los días con horario (L-V por defecto)", () => {
    // 2026-08-08 é sábado; 2026-08-10 é segunda.
    const slots = buildCandidateSlots(settings(), "2026-08-08", "2026-08-10");
    const días = new Set(slots.map((s) => s.startUtc.slice(0, 10)));
    expect(días.has("2026-08-08")).toBe(false); // sábado cerrado
    expect(días.has("2026-08-09")).toBe(false); // domingo cerrado
    expect(días.size).toBeGreaterThan(0); // a segunda sim
  });

  it("respeta la duración configurada", () => {
    const cortos = buildCandidateSlots(
      settings({ slotMinutes: 30 }),
      "2026-08-05",
      "2026-08-05"
    );
    const largos = buildCandidateSlots(
      settings({ slotMinutes: 60 }),
      "2026-08-05",
      "2026-08-05"
    );
    // 09:00-18:00 ⇒ 18 slots de 30 min, 9 de 60.
    expect(cortos).toHaveLength(18);
    expect(largos).toHaveLength(9);
  });

  it("un horario vacío no genera nada (negocio sin configurar días)", () => {
    expect(
      buildCandidateSlots(
        settings({ weeklyHours: {} }),
        "2026-08-03",
        "2026-08-07"
      )
    ).toEqual([]);
  });
});

describe("filterFreeSlots", () => {
  const tz = MX;
  const candidates = buildCandidateSlots(
    settings(),
    "2026-08-05",
    "2026-08-05"
  );

  it("descarta lo que no cumple el aviso mínimo", () => {
    // "Agora" são 09:00 locais do mesmo dia, com 2 h de aviso ⇒ o
    // primeiro vão oferecível é às 11:00 locais (17:00Z).
    const now = new Date("2026-08-05T15:00:00.000Z");
    const free = filterFreeSlots(candidates, [], {
      now,
      minNoticeHours: 2,
      timezone: tz,
    });
    expect(free[0]!.startUtc).toBe("2026-08-05T17:00:00.000Z");
  });

  it("sin aviso mínimo ofrece desde el instante actual", () => {
    const now = new Date("2026-08-05T15:00:00.000Z");
    const free = filterFreeSlots(candidates, [], {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    expect(free[0]!.startUtc).toBe("2026-08-05T15:00:00.000Z");
  });

  it("una cita ocupada retira su hueco y solo ese", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const ocupado = [
      {
        startUtc: "2026-08-05T16:00:00.000Z",
        endUtc: "2026-08-05T16:30:00.000Z",
      },
    ];
    const libres = filterFreeSlots(candidates, ocupado, {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    const inicios = libres.map((s) => s.startUtc);
    expect(inicios).not.toContain("2026-08-05T16:00:00.000Z");
    expect(inicios).toContain("2026-08-05T16:30:00.000Z");
    expect(inicios).toContain("2026-08-05T15:30:00.000Z");
  });

  it("un bloqueo largo retira todos los huecos que toca", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const bloqueo = [
      {
        startUtc: "2026-08-05T15:00:00.000Z",
        endUtc: "2026-08-05T17:00:00.000Z", // 2 h ⇒ 4 slots de 30
      },
    ];
    const libres = filterFreeSlots(candidates, bloqueo, {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    expect(libres).toHaveLength(candidates.length - 4);
  });

  it("devuelve los huecos ordenados y etiquetados", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const libres = filterFreeSlots([...candidates].reverse(), [], {
      now,
      minNoticeHours: 0,
      timezone: tz,
    });
    const tiempos = libres.map((s) => Date.parse(s.startUtc));
    expect([...tiempos].sort((a, b) => a - b)).toEqual(tiempos);
    expect(libres[0]!.label).toContain("09:00");
  });

  it("agenda llena ⇒ lista vacía, no error", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const todo = candidates.map((c) => ({
      startUtc: c.startUtc,
      endUtc: c.endUtc,
    }));
    expect(
      filterFreeSlots(candidates, todo, {
        now,
        minNoticeHours: 0,
        timezone: tz,
      })
    ).toEqual([]);
  });
});

/**
 * Sem distribuição, os primeiros horários são comidos pelo dia de hoje e quem oferece
 * fica sem nada a dizer quando o lead pede outro dia.
 */
describe("spreadByDay", () => {
  // 14:00Z são 08:00 no México: "hoje" é a quarta 5, não a véspera.
  // (Com 00:00Z o dia local do negócio ainda seria o 4 — o motor decide
  // o dia no fuso do negócio, não no do servidor.)
  const now = new Date("2026-08-05T14:00:00.000Z");
  // Qua 5 a sex 7 de agosto, 09:00-18:00, agendamentos de 30 ⇒ 18 horários por dia.
  const libres = filterFreeSlots(
    buildCandidateSlots(settings(), "2026-08-05", "2026-08-07"),
    [],
    { now, minNoticeHours: 0, timezone: MX }
  );

  it("toma como mucho `perDay` de cada día, en vez de los N más próximos", () => {
    const spread = spreadByDay(libres, {
      timezone: MX,
      limit: 12,
      perDay: 3,
      now,
    });
    expect(spread).toHaveLength(9); // 3 días × 3
    expect(daysWithAgenda(spread)).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
  });

  it("el límite corta el total sin romper el reparto", () => {
    const spread = spreadByDay(libres, {
      timezone: MX,
      limit: 4,
      perDay: 3,
      now,
    });
    expect(spread).toHaveLength(4);
    // 3 do primeiro dia + 1 do segundo: o limite não come a variedade.
    expect(daysWithAgenda(spread)).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("cada hueco viaja con su día EN PALABRAS y su hora", () => {
    const spread = spreadByDay(libres, {
      timezone: MX,
      limit: 3,
      perDay: 1,
      now,
    });
    expect(spread[0]!.dayLabel).toMatch(/^hoy /);
    expect(spread[1]!.dayLabel).toMatch(/^mañana /);
    expect(spread[0]!.time).toBe("09:00");
  });

  it("sin huecos no inventa días", () => {
    expect(
      spreadByDay([], { timezone: MX, limit: 12, perDay: 3, now })
    ).toEqual([]);
  });
});

describe("normalizeWeeklyHours", () => {
  it("descarta intervalos inválidos sin tumbar el resto del horario", () => {
    const out = normalizeWeeklyHours({
      mon: [
        { start: "09:00", end: "18:00" },
        { start: "20:00", end: "19:00" }, // fim antes do início
        { start: "9:00", end: "18:00" }, // formato inválido
      ],
      tue: [],
    });
    expect(out.mon).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(out.tue).toBeUndefined(); // dia sem faixas válidas = fechado
  });

  it("ordena las franjas por hora de inicio", () => {
    const out = normalizeWeeklyHours({
      wed: [
        { start: "16:00", end: "18:00" },
        { start: "09:00", end: "13:00" },
      ],
    });
    expect(out.wed?.[0]?.start).toBe("09:00");
  });
});
