import { describe, expect, it } from "vitest";
import {
  findOffered,
  sameInstant,
  type OfferedSlot,
} from "@/server/agenda/offers";

/**
 * 015 — A regra INEGOCIÁVEL: só se reserva o que foi ofertado, comparando
 * por instante EXATO. Estes testes fixam o que um LLM não pode pular.
 */

const OFFERS: OfferedSlot[] = [
  { startUtc: "2026-08-05T15:00:00.000Z", label: "mié 5 ago, 09:00" },
  { startUtc: "2026-08-05T15:30:00.000Z", label: "mié 5 ago, 09:30" },
  { startUtc: "2026-08-06T16:00:00.000Z", label: "jue 6 ago, 10:00" },
];

describe("findOffered", () => {
  it("acepta un instante ofrecido", () => {
    expect(findOffered(OFFERS, "2026-08-05T15:30:00.000Z")?.label).toBe(
      "mié 5 ago, 09:30"
    );
  });

  it("acepta el MISMO instante escrito con otro offset", () => {
    // 09:00 no México é o mesmo instante que 15:00Z: é o mesmo vão.
    expect(findOffered(OFFERS, "2026-08-05T09:00:00.000-06:00")).not.toBeNull();
  });

  it("rechaza un instante que no se ofreció, aunque sea cercano", () => {
    // Um minuto de diferença NÃO é o vão ofertado.
    expect(findOffered(OFFERS, "2026-08-05T15:31:00.000Z")).toBeNull();
    // Um horário perfeitamente válido mas nunca ofertado também não vale.
    expect(findOffered(OFFERS, "2026-08-05T18:00:00.000Z")).toBeNull();
  });

  it("rechaza basura sin lanzar (el modelo alucinó el formato)", () => {
    expect(findOffered(OFFERS, "el martes a las 10")).toBeNull();
    expect(findOffered(OFFERS, "")).toBeNull();
  });

  it("sin oferta previa no hay nada reservable", () => {
    expect(findOffered([], "2026-08-05T15:00:00.000Z")).toBeNull();
  });
});

describe("sameInstant", () => {
  it("compara instantes, no cadenas", () => {
    expect(
      sameInstant("2026-08-05T15:00:00.000Z", "2026-08-05T09:00:00-06:00")
    ).toBe(true);
    expect(
      sameInstant("2026-08-05T15:00:00.000Z", "2026-08-05T15:00:01.000Z")
    ).toBe(false);
  });

  it("una fecha inválida nunca es igual a nada", () => {
    expect(sameInstant("nope", "2026-08-05T15:00:00.000Z")).toBe(false);
  });
});
