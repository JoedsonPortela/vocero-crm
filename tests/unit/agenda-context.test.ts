import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  citasEnContexto,
  citasParaContexto,
  type FilaCita,
} from "@/server/agenda/context";

/**
 * 015 — As consultas do contato no contexto de um cérebro externo
 * (`GET /api/bot/context` → `booking`).
 *
 * A Nea cola este bloco tal como está no seu prompt e o trata como A verdade sobre
 * os agendamentos (`_booking_lines`): sem ele, na edição cloud, reservou um
 * segundo agendamento para quem não chegou ao primeiro, disse às 17:04 que a demo era
 * «hoy a las 10:30» e negou com um motivo inventado um agendamento que a equipe
 * tinha cancelado. Por isso a forma importa tanto quanto o conteúdo: a da
 * edição cloud, para que um mesmo cérebro sirva contra as duas.
 */

const TZ = "America/Mexico_City";
const DIA = 86_400_000;

// Segunda-feira 14 de setembro de 2026, 10:30 em CDMX (UTC-6).
const LUNES_1030 = new Date("2026-09-14T16:30:00.000Z");
// 17:04 da mesma segunda-feira: a hora em que o agente disse «tu demo es hoy a las 10:30».
const LUNES_1704 = new Date("2026-09-14T23:04:00.000Z");

function cita(extra: Partial<FilaCita> = {}): FilaCita {
  return {
    id: "bk_1",
    kind: "session",
    status: "agendada",
    isTest: false,
    scheduledAt: LUNES_1030,
    durationMinutes: 30,
    meetingLink: "https://meet.google.com/aza-iftw-wxp",
    linkPending: false,
    updatedAt: new Date("2026-09-10T12:00:00.000Z"),
    ...extra,
  };
}

describe("la forma de una cita en el contexto", () => {
  it("la etiqueta dice el DÍA en palabras, relativo a ahora, en la zona del negocio", () => {
    // Com a curta («lun 14 sep, 10:30») um modelo não tem como saber que
    // esse agendamento é o de hoje.
    const antes = new Date("2026-09-14T15:00:00.000Z"); // 09:00 da mesma segunda-feira
    expect(citasEnContexto([cita()], TZ, antes).next?.label).toBe(
      "hoje segunda-feira, 14 de setembro, 10:30"
    );
    const domingo = new Date("2026-09-13T18:00:00.000Z");
    expect(citasEnContexto([cita()], TZ, domingo).next?.label).toMatch(/^amanhã segunda-feira/);
  });

  it("trae id, estado, inicio y fin en UTC, enlace y si está pendiente", () => {
    const { next } = citasEnContexto([cita()], TZ, new Date("2026-09-14T15:00:00.000Z"));
    expect(next).toEqual({
      id: "bk_1",
      status: "agendada",
      startUtc: "2026-09-14T16:30:00.000Z",
      endUtc: "2026-09-14T17:00:00.000Z",
      label: "hoje segunda-feira, 14 de setembro, 10:30",
      meetingLink: "https://meet.google.com/aza-iftw-wxp",
      linkPending: false,
    });
  });

  it("con el enlace pendiente lo dice, en vez de prometer uno", () => {
    const { next } = citasEnContexto(
      [cita({ meetingLink: null, linkPending: true })],
      TZ,
      new Date("2026-09-14T15:00:00.000Z")
    );
    expect(next).toMatchObject({ meetingLink: null, linkPending: true });
  });

  it("siempre dice en qué zona están las etiquetas", () => {
    expect(citasEnContexto([], TZ, LUNES_1704).timezone).toBe(TZ);
  });
});

describe("qué citas salen", () => {
  it("sin citas, el bloque existe con las tres vacías (la agenda SÍ se consultó)", () => {
    expect(citasEnContexto([], TZ, LUNES_1704)).toEqual({
      timezone: TZ,
      next: null,
      unresolved: null,
      lastClosed: null,
    });
  });

  it("`next` es la agendada más próxima, no la última creada", () => {
    const martes = cita({ id: "bk_martes", scheduledAt: new Date("2026-09-15T16:30:00.000Z") });
    const jueves = cita({ id: "bk_jueves", scheduledAt: new Date("2026-09-17T16:30:00.000Z") });
    const { next } = citasEnContexto([jueves, martes], TZ, LUNES_1704);
    expect(next?.id).toBe("bk_martes");
  });

  it("una cita que ya empezó y nadie cerró NO es la próxima: va en `unresolved`", () => {
    // O caso das 17:04: dá-la por vigente é dizer «tu demo es hoy a las 10:30».
    const r = citasEnContexto([cita()], TZ, LUNES_1704);
    expect(r.next).toBeNull();
    expect(r.unresolved?.id).toBe("bk_1");
    expect(r.unresolved?.endUtc).toBe("2026-09-14T17:00:00.000Z");
  });

  it("una sin cerrar de hace más de 7 días ya no es tema de conversación", () => {
    const vieja = cita({ scheduledAt: new Date(LUNES_1704.getTime() - 8 * DIA) });
    expect(citasEnContexto([vieja], TZ, LUNES_1704).unresolved).toBeNull();
  });

  it("una cancelada no es la próxima aunque sea futura: va en `lastClosed`", () => {
    const cancelada = cita({
      status: "cancelada",
      scheduledAt: new Date("2026-09-15T16:30:00.000Z"),
      updatedAt: new Date("2026-09-14T22:00:00.000Z"),
    });
    const r = citasEnContexto([cancelada], TZ, LUNES_1704);
    expect(r.next).toBeNull();
    expect(r.lastClosed).toMatchObject({
      id: "bk_1",
      status: "cancelada",
      closedAt: "2026-09-14T22:00:00.000Z",
      // Na raiz só a equipe cancela: por /api/bot/* não existe cancelar.
      cancelledBy: "equipo",
    });
  });

  it("`lastClosed` es la cerrada MÁS RECIENTE, y no lleva enlace: ya no sirve", () => {
    const realizada = cita({
      id: "bk_realizada",
      status: "realizada",
      scheduledAt: new Date("2026-09-11T16:30:00.000Z"),
      updatedAt: new Date("2026-09-11T18:00:00.000Z"),
    });
    const noShow = cita({
      id: "bk_no_show",
      status: "no_show",
      scheduledAt: new Date("2026-09-12T16:30:00.000Z"),
      updatedAt: new Date("2026-09-13T09:00:00.000Z"),
    });
    const { lastClosed } = citasEnContexto([realizada, noShow], TZ, LUNES_1704);
    expect(lastClosed?.id).toBe("bk_no_show");
    expect(lastClosed?.cancelledBy).toBeNull();
    expect(lastClosed).not.toHaveProperty("meetingLink");
    expect(lastClosed).not.toHaveProperty("linkPending");
  });

  it("una cerrada hace más de 7 días ya no sale", () => {
    const vieja = cita({
      status: "cancelada",
      updatedAt: new Date(LUNES_1704.getTime() - 8 * DIA),
    });
    expect(citasEnContexto([vieja], TZ, LUNES_1704).lastClosed).toBeNull();
  });

  it("una cita de PRUEBA jamás aparece, ni siendo la mejor candidata de cada bloque", () => {
    // Do Laboratório: é de um cliente simulado. Apresentá-la como real faria
    // o cérebro negar um agendamento novo ou defender um que não existe.
    const prueba = (extra: Partial<FilaCita>) => cita({ isTest: true, ...extra });
    const r = citasEnContexto(
      [
        prueba({ id: "t_next", scheduledAt: new Date("2026-09-15T16:30:00.000Z") }),
        prueba({ id: "t_unresolved", scheduledAt: LUNES_1030 }),
        prueba({ id: "t_closed", status: "cancelada", updatedAt: LUNES_1704 }),
      ],
      TZ,
      LUNES_1704
    );
    expect(r).toEqual({ timezone: TZ, next: null, unresolved: null, lastClosed: null });
  });

  it("un bloqueo del operador no es una cita de nadie", () => {
    const bloqueo = cita({ kind: "block", scheduledAt: new Date("2026-09-15T16:30:00.000Z") });
    expect(citasEnContexto([bloqueo], TZ, LUNES_1704).next).toBeNull();
  });
});

/* -------- citasParaContexto: a flag e a degradação -------- */

// `vi.hoisted`: o módulo sob teste é importado acima, e o mock precisa
// existir antes de esse import resolver `@/lib/db`.
const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb };
});

vi.mock("@/server/agenda/settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/settings")>();
  return {
    ...original,
    getSettings: vi.fn(async () => ({
      ...original.DEFAULT_CALENDAR_SETTINGS,
      timezone: "America/Bogota",
    })),
  };
});

/** Uma base cujo `select … from … where` devolve `rows` (ou estoura). */
function baseCon(rows: FilaCita[] | Error) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void
  ) => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)).then(resolve, reject);
  return { select: () => chain };
}

describe("citasParaContexto", () => {
  beforeEach(() => {
    getDb.mockReset();
  });

  it("con la agenda APAGADA no hay bloque, y ni se toca la base", async () => {
    vi.stubEnv("AGENDA", "");
    await expect(citasParaContexto("org_1", "ct_1")).resolves.toBeNull();
    expect(getDb).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("encendida, elige sobre lo que lee y etiqueta en la zona configurada", async () => {
    vi.stubEnv("AGENDA", "on");
    getDb.mockReturnValue(
      baseCon([
        cita({ id: "bk_prueba", isTest: true, scheduledAt: new Date("2026-09-15T15:00:00.000Z") }),
        cita({ id: "bk_real", scheduledAt: new Date("2026-09-16T15:00:00.000Z") }),
      ])
    );
    const r = await citasParaContexto("org_1", "ct_1", LUNES_1704);
    expect(r?.timezone).toBe("America/Bogota");
    expect(r?.next?.id).toBe("bk_real");
    // 15:00Z é 10:00 em Bogotá (UTC-5).
    expect(r?.next?.label).toBe("quarta-feira, 16 de setembro, 10:00");
    vi.unstubAllEnvs();
  });

  it("si la lectura falla, no hay bloque — y el contexto no se cae por eso", async () => {
    vi.stubEnv("AGENDA", "on");
    getDb.mockReturnValue(baseCon(new Error("conexión perdida")));
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(citasParaContexto("org_1", "ct_1", LUNES_1704)).resolves.toBeNull();
    expect(consola).toHaveBeenCalled();
    consola.mockRestore();
    vi.unstubAllEnvs();
  });
});
