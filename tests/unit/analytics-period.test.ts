import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.APP_BASE_URL = "https://app.ejemplo.test";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

const { daysApart, median, PeriodError, resolvePeriod } = await import(
  "@/server/analytics/period"
);
const { bucketsDelPeriodo } = await import("@/lib/analytics");
const { shortcuts } = await import("@/components/results/range-picker");

/**
 * 019 — Os períodos da tela Resultados (portado do Vocero Cloud).
 *
 * O que se fixa aqui é que os cortes caem na zona do NEGÓCIO: com
 * cortes em UTC, tudo o que acontece depois das 18:00 no México cai no dia
 * seguinte e o dono compararia sua segunda-feira com uma segunda-feira que não existe.
 */

const MX = "America/Mexico_City";

describe("resolvePeriod", () => {
  const ahora = new Date("2026-03-15T18:00:00Z");

  it("sin fechas, son los últimos 30 días terminando hoy", () => {
    const p = resolvePeriod({ timezone: MX, now: ahora });
    expect(p.dto.to).toBe("2026-03-15");
    expect(p.dto.from).toBe("2026-02-14");
    expect(p.dto.days).toBe(30);
  });

  it("'hoy' es el del negocio: las 20:00 del 5 en México siguen siendo el 5", () => {
    // 2026-03-06T02:00Z já é dia 6 em UTC.
    const p = resolvePeriod({ timezone: MX, now: new Date("2026-03-06T02:00:00Z") });
    expect(p.dto.to).toBe("2026-03-05");
  });

  it("el periodo anterior dura LO MISMO y termina justo antes", () => {
    // Senão, a comparação misturaria um mês de 30 dias com um de 31 e o
    // "+8 %" da tela seria um artefato do calendário.
    const p = resolvePeriod({ from: "2026-03-01", to: "2026-03-10", timezone: MX });
    expect(p.dto.days).toBe(10);
    expect(p.dto.previousTo).toBe("2026-02-28");
    expect(p.dto.previousFrom).toBe("2026-02-19");
  });

  it("el fin es EXCLUSIVO: arranca el día siguiente", () => {
    const p = resolvePeriod({ from: "2026-03-01", to: "2026-03-01", timezone: MX });
    expect(p.dto.days).toBe(1);
    expect(p.end.getTime() - p.start.getTime()).toBe(86_400_000);
  });

  it("los cortes son medianoche en la zona del negocio, no en UTC", () => {
    const p = resolvePeriod({ from: "2026-03-01", to: "2026-03-01", timezone: MX });
    // Meia-noite de 1 de março no México (UTC-6) são as 06:00Z.
    expect(p.start.toISOString()).toBe("2026-03-01T06:00:00.000Z");
  });

  it("un día con cambio de horario dura lo que dura en la zona", () => {
    // Nova York adianta o relógio em 8 de março de 2026: esse dia tem 23 h.
    const p = resolvePeriod({
      from: "2026-03-08",
      to: "2026-03-08",
      timezone: "America/New_York",
    });
    expect(p.end.getTime() - p.start.getTime()).toBe(23 * 3_600_000);
  });

  it("el anterior termina EXACTAMENTE donde empieza el actual, sin hueco", () => {
    const p = resolvePeriod({ from: "2026-03-01", to: "2026-03-10", timezone: MX });
    expect(p.previousEnd.getTime()).toBe(p.start.getTime());
  });

  it("pasados 92 días agrupa por mes", () => {
    const corto = resolvePeriod({ from: "2026-01-01", to: "2026-04-02", timezone: MX });
    expect(corto.dto.days).toBe(92);
    expect(corto.dto.granularity).toBe("day");

    const largo = resolvePeriod({ from: "2026-01-01", to: "2026-04-03", timezone: MX });
    expect(largo.dto.granularity).toBe("month");
  });

  it("rechaza el rango invertido", () => {
    expect(() =>
      resolvePeriod({ from: "2026-03-10", to: "2026-03-01", timezone: MX })
    ).toThrow(PeriodError);
  });

  it("rechaza más de 366 días", () => {
    expect(() =>
      resolvePeriod({ from: "2024-01-01", to: "2026-01-01", timezone: MX })
    ).toThrow(PeriodError);
  });

  it("rechaza una fecha con formato inventado o que no existe", () => {
    // Chega da barra de endereços: tem que ser um 422 com mensagem, não
    // um NaN que se propague até uma consulta.
    expect(() => resolvePeriod({ from: "ayer", to: "2026-03-01", timezone: MX })).toThrow(
      PeriodError
    );
    expect(() =>
      resolvePeriod({ from: "2026-02-31", to: "2026-03-01", timezone: MX })
    ).toThrow(PeriodError);
  });

  it("una zona horaria inválida no tumba la pantalla", () => {
    const p = resolvePeriod({ from: "2026-03-01", to: "2026-03-02", timezone: "Marte/Olimpo" });
    expect(p.timezone).toBe("America/Mexico_City");
  });
});

describe("daysApart", () => {
  it("cuenta bien un año bisiesto y no se descuadra con el horario de verano", () => {
    expect(daysApart("2028-02-01", "2028-03-01")).toBe(29);
    expect(daysApart("2026-04-01", "2026-04-30")).toBe(29);
  });
});

describe("bucketsDelPeriodo", () => {
  it("un día sin movimientos es una cubeta en cero, no un hueco", () => {
    expect(
      bucketsDelPeriodo({ from: "2026-02-27", to: "2026-03-02", granularity: "day" })
    ).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });

  it("por mes, cruzando el año", () => {
    expect(
      bucketsDelPeriodo({ from: "2025-11-15", to: "2026-02-03", granularity: "month" })
    ).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("el rango más largo cabe entero", () => {
    const p = resolvePeriod({ from: "2025-01-01", to: "2026-01-01", timezone: MX });
    expect(bucketsDelPeriodo(p.dto)).toHaveLength(13);
  });
});

describe("atajos del rango", () => {
  it("se calculan sobre el hoy del negocio, en fechas de calendario", () => {
    const a = Object.fromEntries(shortcuts("2026-03-15").map((s) => [s.label, s.range]));
    expect(a["7 dias"]).toEqual({ from: "2026-03-09", to: "2026-03-15" });
    expect(a["30 dias"]).toEqual({ from: "2026-02-14", to: "2026-03-15" });
    expect(a["Este mes"]).toEqual({ from: "2026-03-01", to: "2026-03-15" });
    // Março: o mês passado é um fevereiro de 28 dias.
    expect(a["Mes pasado"]).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("en enero, el mes pasado es diciembre del año anterior", () => {
    const a = Object.fromEntries(shortcuts("2026-01-05").map((s) => [s.label, s.range]));
    expect(a["Mes pasado"]).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("'30 días' coincide con el periodo por defecto del servidor", () => {
    const hoy = "2026-03-15";
    const servidor = resolvePeriod({ timezone: MX, now: new Date("2026-03-15T18:00:00Z") });
    const cliente = shortcuts(hoy).find((s) => s.label === "30 dias")!.range;
    expect(cliente).toEqual({ from: servidor.dto.from, to: servidor.dto.to });
  });
});

describe("median", () => {
  it("con lista vacía es null, no cero", () => {
    // Zero significaria "respondeu na hora"; null significa "não houve nada
    // que medir. A tela os mostra de forma distinta.
    expect(median([])).toBeNull();
  });

  it("impar toma el de en medio; par promedia los dos centrales", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);
  });

  it("un valor extremo no la arrastra", () => {
    expect(median([2, 3, 4, 5, 100_000])).toBe(4);
  });
});
