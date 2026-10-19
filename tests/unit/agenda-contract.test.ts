import { describe, expect, it } from "vitest";
import {
  bookingErrorResponse,
  bookingErrorStatus,
  bookingPayload,
} from "@/server/agenda/http";
import { BookingError } from "@/server/agenda/service";
import { agendaDisabledResponse } from "@/server/agenda/flag";

/**
 * 015 — O CONTRATO observável da agenda, fixado num teste.
 *
 * Não é purismo REST: as duas falhas que isto previne ocorreram em
 * produção e nenhuma foi detectada pelos mocks, porque os mocks respondiam
 * outra coisa que o servidor real. Aqui o cliente e o servidor olham a mesma
 * definição.
 */

const result = {
  booking: { id: "bk_123" },
  meetingLink: "https://meet.ejemplo.com/sala",
  linkPending: false,
  label: "mié 5 ago, 09:00",
} as never;

describe("cuerpo de una reserva creada", () => {
  it("lleva el id, el enlace, si el enlace está pendiente y la etiqueta", () => {
    expect(bookingPayload(result)).toEqual({
      bookingId: "bk_123",
      meetingLink: "https://meet.ejemplo.com/sala",
      linkPending: false,
      label: "mié 5 ago, 09:00",
    });
  });

  it("`linkPending` viaja SIEMPRE: es lo que decide si se promete el enlace", () => {
    const pendiente = bookingPayload({
      ...(result as object),
      meetingLink: null,
      linkPending: true,
    } as never);
    expect(pendiente.meetingLink).toBeNull();
    expect(pendiente.linkPending).toBe(true);
  });
});

describe("códigos de estado", () => {
  it("los conflictos de hueco son 409, no 400", () => {
    expect(bookingErrorStatus("slot_taken")).toBe(409);
    expect(bookingErrorStatus("slot_not_offered")).toBe(409);
  });

  it("no encontrado es 404 y payload inválido 422", () => {
    expect(bookingErrorStatus("not_found")).toBe(404);
    expect(bookingErrorStatus("invalid")).toBe(422);
  });
});

describe("forma del error", () => {
  it("el sobre va ANIDADO y `slots` es HERMANO de `error`", async () => {
    const slots = [{ startUtc: "2026-08-05T15:30:00.000Z", label: "mié 5 ago, 09:30" }];
    const res = bookingErrorResponse(
      new BookingError("slot_taken", "Ese horario acaba de ocuparse", slots)
    );
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      error: { code: string; message: string };
      slots: { label: string }[];
    };
    // Aninhado: um mock com a forma plana `{code}` fez com que todo 409 fosse lido
    // como conflito genérico e o caminho de nova oferta nunca fosse ativado.
    expect(body.error.code).toBe("slot_taken");
    expect(body.error.message).toContain("ocuparse");
    // Irmão: é o que o cliente usa para oferecer de novo sem outra ida e volta.
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0]!.label).toBe("mié 5 ago, 09:30");
  });

  it("`invalid` sale como `invalid_body`, el código que ya usa el resto de la API", async () => {
    const res = bookingErrorResponse(new BookingError("invalid", "Instante inválido"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  it("un error que no es del dominio se relanza en vez de disfrazarse de 409", () => {
    expect(() => bookingErrorResponse(new Error("se cayó la base"))).toThrow(
      "se cayó la base"
    );
  });
});

describe("la agenda apagada", () => {
  it("responde 404 sin cuerpo: ese endpoint no existe en esta instancia", () => {
    const res = agendaDisabledResponse();
    // 404 e não 403: um 403 confirmaria que a agenda existe mas está vedada.
    expect(res.status).toBe(404);
  });
});
