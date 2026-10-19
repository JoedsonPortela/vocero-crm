import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 015 — A corrida pelo horário (FR-006).
 *
 * Duas confirmações simultâneas do mesmo instante passam ambas pela
 * re-validação —entre ler e escrever cabe a outra— e é a BASE quem as
 * separa, com o índice único parcial. O que se fixa aqui é a tradução desse
 * choque: `23505` ⇒ `slot_taken` COM alternativas frescas, e jamais um
 * agendamento criado.
 *
 * A corrida de verdade, com duas requisições concorrentes contra o app vivo, roda
 * o harness E2E: isto garante que, quando ocorrer, a resposta seja útil.
 */

const settings = {
  weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "enlace-fijo" as const,
  meetingLink: "https://meet.ejemplo.com/sala",
};

const SLOT = "2026-08-05T15:00:00.000Z";

const ALTERNATIVES = [
  { startUtc: "2026-08-05T15:30:00.000Z", endUtc: "…", label: "mié 5 ago, 09:30" },
  { startUtc: "2026-08-05T16:00:00.000Z", endUtc: "…", label: "mié 5 ago, 10:00" },
];

const replaceOffers = vi.fn(async () => {});
const clearOffers = vi.fn(async () => {});
const moveLeadToStage = vi.fn(async () => ({ ok: true as const }));
const createMeeting = vi.fn(async () => ({
  externalId: null,
  joinUrl: settings.meetingLink,
}));

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => settings,
}));

vi.mock("@/server/agenda/availability", () => ({
  // O horário aparece livre na re-validação: a outra confirmação ainda não escrevia.
  findSlot: async () => ({ startUtc: SLOT, endUtc: "…", label: "mié 5 ago, 09:00" }),
  computeAvailability: async () => ALTERNATIVES,
}));

vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return {
    ...original,
    getOffers: async () => [{ startUtc: SLOT, label: "mié 5 ago, 09:00" }],
    replaceOffers,
    clearOffers,
  };
});

vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: async () => ({
    id: "enlace-fijo",
    createMeeting,
    updateMeeting: async () => {},
    deleteMeeting: async () => {},
    testConnection: async () => ({ ok: true }),
  }),
  markConnectorAuthError: async () => {},
}));

vi.mock("@/server/leads/stage-history", () => ({ moveLeadToStage }));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));

/** Fila de resultados para cada `select(...).limit(n)` na ordem da chamada. */
const selectRows: unknown[][] = [];
/** Se tiver algo, o INSERT o lança em vez de inserir. */
let insertThrows: unknown = null;
const inserted: unknown[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) {
    c[m] = () => c;
  }
  c.limit = () => Promise.resolve(rows);
  return c;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => chain(selectRows.shift() ?? []),
    insert: () => ({
      values: (v: unknown) => ({
        returning: () => {
          if (insertThrows) return Promise.reject(insertThrows);
          inserted.push(v);
          return Promise.resolve([
            {
              ...(v as object),
              scheduledAt: new Date(SLOT),
              meetingLink: null,
              linkPending: false,
              isTest: false,
              externalRef: null,
            },
          ]);
        },
      }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: "bk_1",
                organizationId: "org_1",
                scheduledAt: new Date(SLOT),
                durationMinutes: 30,
                isTest: false,
                connector: "enlace-fijo",
                notes: null,
                contactId: "ct_1",
                ...(v as object),
              },
            ]),
        }),
      }),
    }),
  }),
  schema: {
    booking: {},
    conversation: { organizationId: "organizationId", id: "id" },
    contact: { organizationId: "organizationId", id: "id", name: "name" },
    lead: { organizationId: "organizationId", contactId: "contactId" },
    pipelineStage: { organizationId: "organizationId" },
    offeredSlot: {},
  },
}));

function primeLookups() {
  // 1) a conversa, 2) o nome do contato, 3) o lead
  selectRows.push([{ contactId: "ct_1", isTest: false }]);
  selectRows.push([{ name: "Ana" }]);
  selectRows.push([{ id: "ld_1" }]);
}

describe("la carrera del hueco", () => {
  beforeEach(() => {
    selectRows.length = 0;
    inserted.length = 0;
    insertThrows = null;
    replaceOffers.mockClear();
    clearOffers.mockClear();
  });

  it("un 23505 se traduce a slot_taken con alternativas frescas, sin crear la cita", async () => {
    const { createSessionBooking, BookingError } = await import(
      "@/server/agenda/service"
    );
    primeLookups();
    insertThrows = { code: "23505" };

    const promise = createSessionBooking({
      organizationId: "org_1",
      conversationId: "cv_1",
      startUtc: SLOT,
      source: "ai",
      requireOffer: true,
    });

    await expect(promise).rejects.toBeInstanceOf(BookingError);
    await promise.catch((err) => {
      expect(err.code).toBe("slot_taken");
      // Com alternativas concretas: sem elas, a conversa fica sem
      // saída e o cliente sem agendamento.
      expect(err.slots).toHaveLength(2);
      expect(err.slots[0].label).toBe("mié 5 ago, 09:30");
    });

    // E ficam REGISTRADAS como a nova oferta: o cliente pode aceitar uma
    // de imediato e a validação seguirá sendo válida.
    expect(replaceOffers).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });

  it("el 23505 también se reconoce cuando el driver lo envuelve en `cause`", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    insertThrows = Object.assign(new Error("insert falló"), {
      cause: { code: "23505" },
    });

    await expect(
      createSessionBooking({
        organizationId: "org_1",
        conversationId: "cv_1",
        startUtc: SLOT,
        source: "ai",
        requireOffer: true,
      })
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("un error que NO es la carrera se propaga tal cual, sin disfrazarse de slot_taken", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    insertThrows = { code: "23503", message: "foreign key" };

    await expect(
      createSessionBooking({
        organizationId: "org_1",
        conversationId: "cv_1",
        startUtc: SLOT,
        source: "ai",
        requireOffer: true,
      })
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("un instante que nunca se ofreció se rechaza ANTES de tocar la base", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();

    const promise = createSessionBooking({
      organizationId: "org_1",
      conversationId: "cv_1",
      // Livre e válido, mas jamais ofertado nesta conversa.
      startUtc: "2026-08-05T20:00:00.000Z",
      source: "ai",
      requireOffer: true,
    });

    await expect(promise).rejects.toMatchObject({ code: "slot_not_offered" });
    await promise.catch((err) => {
      // Devolve-se o que FOI ofertado, para que se reoferte em vez de
      // inventar.
      expect(err.slots[0].startUtc).toBe(SLOT);
    });
    expect(inserted).toHaveLength(0);
  });
});
