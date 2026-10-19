import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 016 — O evento que sai para a Meta.
 *
 * Estes testes existem por um motivo bem concreto: o modo de falhar de
 * `POST {dataset}/events` é um **200 com `events_received: 0`**. Um campo mal
 * posto aparece exatamente igual a um bem posto, então o formato do
 * payload e a leitura do aceite ficam fixados aqui, onde se pode afirmar.
 */

const graphRequest = vi.fn();

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});

const { buildEventPayload, sendBusinessMessagingEvent, isMetaBusinessMessagingEvent } =
  await import("@/lib/meta/capi");

const EVENT = {
  eventName: "QualifiedLead",
  eventTime: 1787000000,
  ctwaClid: "ARAaB_clic",
  wabaId: "WABA-1",
};

beforeEach(() => {
  graphRequest.mockReset();
});

describe("buildEventPayload", () => {
  it("arma el evento de mensajería con los campos que Meta exige", () => {
    const body = buildEventPayload(EVENT) as {
      data: Record<string, unknown>[];
      partner_agent: string;
    };
    const event = body.data[0]!;

    expect(event.event_name).toBe("QualifiedLead");
    expect(event.event_time).toBe(1787000000);
    expect(event.action_source).toBe("business_messaging");
    expect(event.messaging_channel).toBe("whatsapp");
    expect(event.user_data).toEqual({
      ctwa_clid: "ARAaB_clic",
      whatsapp_business_account_id: "WABA-1",
    });
    // Quem integrou o evento: o projeto, não o negócio nem uma agência.
    expect(body.partner_agent).toBe("vocero-crm");
  });

  it("hacia Meta no viaja NADA personal del contacto", () => {
    const body = buildEventPayload(EVENT) as {
      data: Record<string, unknown>[];
    };
    const userData = body.data[0]!.user_data as Record<string, unknown>;
    // `user_data` é o envelope onde a Meta espera dados de pessoa: aqui só
    // leva o identificador do clique e o da conta do negócio.
    expect(Object.keys(userData).sort()).toEqual([
      "ctwa_clid",
      "whatsapp_business_account_id",
    ]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("phone");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("\"name\"");
  });

  it("incluye custom_data cuando lo hay, y lo omite cuando está vacío", () => {
    const con = buildEventPayload({
      ...EVENT,
      customData: { lead_stage: "qualified" },
    }) as { data: Record<string, unknown>[] };
    expect(con.data[0]!.custom_data).toEqual({ lead_stage: "qualified" });

    const sin = buildEventPayload({ ...EVENT, customData: {} }) as {
      data: Record<string, unknown>[];
    };
    // Um `custom_data: {}` não agrega nada verificável e suja o payload que
    // alguém inspeciona quando algo falha.
    expect(sin.data[0]!.custom_data).toBeUndefined();
  });

  it("el valor de una venta viaja en unidades de la moneda", () => {
    const body = buildEventPayload({
      ...EVENT,
      eventName: "Purchase",
      customData: { lead_stage: "won", value: 450.5, currency: "MXN" },
    }) as { data: Record<string, unknown>[] };
    expect(body.data[0]!.custom_data).toEqual({
      lead_stage: "won",
      value: 450.5,
      currency: "MXN",
    });
  });
});

describe("catálogo cerrado", () => {
  it("reconoce los nombres de Meta y rechaza los inventados", () => {
    expect(isMetaBusinessMessagingEvent("QualifiedLead")).toBe(true);
    expect(isMetaBusinessMessagingEvent("Purchase")).toBe(true);
    // O nome de domínio do fork de onde vem esta ideia: NÃO existe na Meta.
    expect(isMetaBusinessMessagingEvent("LeadQualified")).toBe(false);
    expect(isMetaBusinessMessagingEvent("SessionBooked")).toBe(false);
  });

  it("un nombre fuera del catálogo falla ANTES de salir a la red", async () => {
    await expect(
      sendBusinessMessagingEvent({
        datasetId: "ds_1",
        token: "tok",
        event: { ...EVENT, eventName: "LeadQualified" },
      })
    ).rejects.toThrow(/catálogo/);
    expect(graphRequest).not.toHaveBeenCalled();
  });
});

describe("el acuse de Meta", () => {
  it("con events_received >= 1 el evento cuenta como enviado", async () => {
    graphRequest.mockResolvedValue({
      events_received: 1,
      fbtrace_id: "Aki123",
    });
    const ack = await sendBusinessMessagingEvent({
      datasetId: "ds_1",
      token: "tok",
      event: EVENT,
    });
    expect(ack.eventsReceived).toBe(1);
    expect(ack.fbTraceId).toBe("Aki123");
    expect(graphRequest).toHaveBeenCalledWith(
      "ds_1/events",
      expect.objectContaining({ method: "POST", token: "tok" })
    );
  });

  it("un 200 con events_received: 0 es un FALLO, no un envío", async () => {
    // A Meta responde 200 mesmo que descarte o evento. Sem olhar o aceite,
    // "enviado" só significaria "não houve erro HTTP".
    graphRequest.mockResolvedValue({
      events_received: 0,
      fbtrace_id: "AkiZZZ",
    });
    await expect(
      sendBusinessMessagingEvent({
        datasetId: "ds_1",
        token: "tok",
        event: EVENT,
      })
    ).rejects.toThrow(/events_received=0/);
  });

  it("una respuesta sin el campo tampoco se toma por buena", async () => {
    graphRequest.mockResolvedValue({});
    await expect(
      sendBusinessMessagingEvent({
        datasetId: "ds_1",
        token: "tok",
        event: EVENT,
      })
    ).rejects.toThrow(/events_received=0/);
  });
});
