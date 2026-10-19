import { describe, expect, it } from "vitest";
import {
  bookingSegments,
  clampListTo,
  datesOf,
  hhmm,
  isIsoDate,
  layoutOverlaps,
  longDayLabel,
  monthWeeks,
  offHoursBands,
  parseRangeQuery,
  rangeLabel,
  shiftRange,
  spanLabel,
  startOfWeek,
  tzOffsetLabel,
  visibleRange,
  wallClock,
  weekdayKeyOfDate,
} from "@/lib/time/calendar";

/**
 * 215 — A aritmética do calendário de Agendamentos. O que se testa aqui é o que
 * à primeira vista "parece certo" e mesmo assim pinta um agendamento no dia ou na
 * hora errados: a semana que começa na segunda, o mês de seis linhas, o fuso
 * do negócio contra o do navegador e o agendamento que cruza a meia-noite.
 */

const MX = "America/Mexico_City";
const NY = "America/New_York";
const MADRID = "Europe/Madrid";

describe("fechas de calendario", () => {
  it("una fecha inexistente no pasa aunque Date.parse la acepte", () => {
    expect(isIsoDate("2026-09-18")).toBe(true);
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2026-9-18")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });

  it("la semana empieza en lunes, como el horario de Ajustes → Agenda", () => {
    expect(startOfWeek("2026-09-18")).toBe("2026-09-14"); // sexta → segunda
    expect(startOfWeek("2026-09-14")).toBe("2026-09-14"); // segunda → ela mesma
    expect(startOfWeek("2026-09-20")).toBe("2026-09-14"); // domingo → a segunda anterior
    expect(weekdayKeyOfDate("2026-09-20")).toBe("sun");
  });
});

describe("visibleRange — qué días se ven", () => {
  it("día, semana y lista", () => {
    expect(visibleRange("dia", "2026-09-18")).toEqual({ from: "2026-09-18", to: "2026-09-18" });
    expect(visibleRange("semana", "2026-09-18")).toEqual({ from: "2026-09-14", to: "2026-09-20" });
    expect(visibleRange("lista", "2026-09-18")).toEqual({ from: "2026-09-18", to: "2026-10-17" });
    expect(visibleRange("lista", "2026-09-18", "2026-09-30")).toEqual({
      from: "2026-09-18",
      to: "2026-09-30",
    });
  });

  it("el mes cubre semanas completas, de 4 a 6 filas", () => {
    // Setembro 2026: o dia 1 é terça e o 30 quarta → 5 linhas.
    expect(visibleRange("mes", "2026-09-18")).toEqual({ from: "2026-08-31", to: "2026-10-04" });
    expect(monthWeeks("2026-09-18")).toHaveLength(5);
    // Agosto 2026: o dia 1 é sábado e o 31 segunda → 6 linhas.
    expect(monthWeeks("2026-08-10")).toHaveLength(6);
    // Fevereiro 2027: começa na segunda e tem 28 dias → 4 linhas.
    expect(monthWeeks("2027-02-10")).toHaveLength(4);
    expect(monthWeeks("2026-09-18").every((w) => w.length === 7)).toBe(true);
  });

  it("la Lista nunca pasa del máximo ni termina antes de empezar", () => {
    expect(clampListTo("2026-09-18", "2027-09-18")).toBe("2026-12-18"); // 92 dias
    expect(datesOf({ from: "2026-09-18", to: clampListTo("2026-09-18", "2027-09-18") })).toHaveLength(92);
    expect(clampListTo("2026-09-18", "2026-09-01")).toBe("2026-09-18");
    expect(clampListTo("2026-09-18", "no-es-fecha")).toBe("2026-10-17");
  });
});

describe("shiftRange — ‹ ›", () => {
  it("día y semana", () => {
    expect(shiftRange("dia", "2026-09-18", 1).anchor).toBe("2026-09-19");
    expect(shiftRange("semana", "2026-09-18", -1).anchor).toBe("2026-09-11");
  });

  it("el mes salta al día 1 del mes vecino, también de diciembre a enero", () => {
    expect(shiftRange("mes", "2026-09-18", 1).anchor).toBe("2026-10-01");
    expect(shiftRange("mes", "2026-12-31", 1).anchor).toBe("2027-01-01");
    expect(shiftRange("mes", "2026-03-31", -1).anchor).toBe("2026-02-01");
  });

  it("la Lista se desplaza su propio largo", () => {
    expect(shiftRange("lista", "2026-09-01", 1, "2026-09-10")).toEqual({
      anchor: "2026-09-11",
      listTo: "2026-09-20",
    });
    expect(shiftRange("lista", "2026-09-11", -1, "2026-09-20")).toEqual({
      anchor: "2026-09-01",
      listTo: "2026-09-10",
    });
  });
});

describe("etiquetas — lo que dice la barra", () => {
  it("semana en un mes, entre meses y entre años", () => {
    expect(rangeLabel("semana", "2026-09-18")).toBe("14 – 20 de sep de 2026");
    expect(rangeLabel("semana", "2026-09-30")).toBe("28 de sep – 4 de oct de 2026");
    expect(rangeLabel("semana", "2026-12-30")).toBe("28 de dic de 2026 – 3 de ene de 2027");
  });

  it("día, mes y lista", () => {
    expect(rangeLabel("dia", "2026-09-18")).toBe("Viernes, 18 de septiembre de 2026");
    expect(rangeLabel("mes", "2026-09-18")).toBe("Septiembre de 2026");
    expect(rangeLabel("lista", "2026-09-18", "2026-10-17")).toBe("18 de sep – 17 de oct de 2026");
    expect(spanLabel({ from: "2026-09-18", to: "2026-09-18" })).toBe("18 de sep de 2026");
    expect(longDayLabel("2026-09-16")).toBe("miércoles, 16 de septiembre");
  });
});

describe("wallClock y tramos — en la zona del NEGOCIO", () => {
  it("la hora de pared sale de la zona, no del proceso", () => {
    // 15:30 no México são 21:30Z; em Madri, 23:30.
    expect(wallClock("2026-09-18T21:30:00.000Z", MX)).toEqual({ day: "2026-09-18", minutes: 15 * 60 + 30 });
    expect(wallClock("2026-09-18T21:30:00.000Z", MADRID)).toEqual({ day: "2026-09-18", minutes: 23 * 60 + 30 });
    // Às 02:00Z do dia 19 no México ainda é dia 18.
    expect(wallClock("2026-09-19T02:00:00.000Z", MX).day).toBe("2026-09-18");
    expect(hhmm(15 * 60 + 5)).toBe("15:05");
  });

  it("una cita normal es un tramo de su duración", () => {
    expect(bookingSegments("2026-09-18T16:00:00.000Z", 30, MX)).toEqual([
      { day: "2026-09-18", startMin: 600, endMin: 630, continuesBefore: false, continuesAfter: false },
    ]);
  });

  it("la que cruza la medianoche se parte en dos días", () => {
    // 23:00 México + 120 min → 01:00 do dia seguinte.
    expect(bookingSegments("2026-09-19T05:00:00.000Z", 120, MX)).toEqual([
      { day: "2026-09-18", startMin: 1380, endMin: 1440, continuesBefore: false, continuesAfter: true },
      { day: "2026-09-19", startMin: 0, endMin: 60, continuesBefore: true, continuesAfter: false },
    ]);
  });

  it("la que termina justo a medianoche no deja un tramo vacío al día siguiente", () => {
    expect(bookingSegments("2026-09-19T05:00:00.000Z", 60, MX)).toEqual([
      { day: "2026-09-18", startMin: 1380, endMin: 1440, continuesBefore: false, continuesAfter: false },
    ]);
  });

  it("en el retroceso del horario de verano conserva su duración", () => {
    // Nova York, 1 nov 2026: 01:30 (EDT) + 60 min = 01:30 (EST).
    const [seg] = bookingSegments("2026-11-01T05:30:00.000Z", 60, NY);
    expect(seg?.startMin).toBe(90);
    expect(seg?.endMin).toBe(150);
  });

  it("el desfase se escribe como Google", () => {
    expect(tzOffsetLabel(MX, new Date("2026-09-18T12:00:00Z"))).toBe("GMT-6");
    expect(tzOffsetLabel("Asia/Kolkata", new Date("2026-09-18T12:00:00Z"))).toBe("GMT+5:30");
    expect(tzOffsetLabel("UTC", new Date("2026-09-18T12:00:00Z"))).toBe("GMT");
  });

  it("con el reloj real (con milisegundos) el desfase sigue siendo entero", () => {
    expect(tzOffsetLabel(MX, new Date("2026-09-18T18:15:57.623Z"))).toBe("GMT-6");
  });
});

describe("layoutOverlaps — lo que se solapa comparte el ancho", () => {
  it("sin solape, cada cita ocupa la columna entera", () => {
    const out = layoutOverlaps([
      { id: "a", startMin: 600, endMin: 630 },
      { id: "b", startMin: 630, endMin: 660 },
    ]);
    expect(out.map((o) => [o.id, o.col, o.cols])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ]);
  });

  it("dos que se tocan se reparten; la tercera reutiliza la columna libre", () => {
    const out = layoutOverlaps([
      { id: "a", startMin: 660, endMin: 690 }, // 11:00–11:30
      { id: "b", startMin: 675, endMin: 720 }, // 11:15–12:00
      { id: "c", startMin: 690, endMin: 720 }, // 11:30–12:00
    ]);
    const byId = Object.fromEntries(out.map((o) => [o.id, [o.col, o.cols]]));
    expect(byId).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2] });
  });

  it("un grupo aparte no hereda las columnas del anterior", () => {
    const out = layoutOverlaps([
      { id: "a", startMin: 600, endMin: 660 },
      { id: "b", startMin: 610, endMin: 640 },
      { id: "c", startMin: 900, endMin: 930 },
    ]);
    expect(out.find((o) => o.id === "c")).toMatchObject({ col: 0, cols: 1 });
  });
});

describe("offHoursBands — lo que se sombrea", () => {
  const horario = {
    mon: [{ start: "09:00", end: "14:00" }, { start: "16:00", end: "19:00" }],
  };

  it("horario partido: antes, entre y después", () => {
    expect(offHoursBands(horario, "2026-09-14")).toEqual([
      { startMin: 0, endMin: 540 },
      { startMin: 840, endMin: 960 },
      { startMin: 1140, endMin: 1440 },
    ]);
  });

  it("un día cerrado se sombrea entero", () => {
    expect(offHoursBands(horario, "2026-09-15")).toEqual([{ startMin: 0, endMin: 1440 }]);
  });
});

describe("parseRangeQuery — ?from=&to= de /api/bookings", () => {
  it("sin parámetros, la lista de siempre", () => {
    expect(parseRangeQuery(null, null)).toEqual({ ok: true, range: null });
  });

  it("un rango válido", () => {
    expect(parseRangeQuery("2026-09-14", "2026-09-20")).toEqual({
      ok: true,
      range: { from: "2026-09-14", to: "2026-09-20" },
    });
  });

  it("rechaza lo que el calendario no puede pedir", () => {
    expect(parseRangeQuery("2026-09-14", null).ok).toBe(false);
    expect(parseRangeQuery("2026-02-31", "2026-03-05").ok).toBe(false);
    expect(parseRangeQuery("2026-09-20", "2026-09-14").ok).toBe(false);
    expect(parseRangeQuery("2026-01-01", "2026-04-03").ok).toBe(false); // 93 dias
    expect(parseRangeQuery("2026-01-01", "2026-04-02").ok).toBe(true); // 92 dias, o teto
  });
});
