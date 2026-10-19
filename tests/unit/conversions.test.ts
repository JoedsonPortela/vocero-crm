import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  purchaseCustomData,
  toConversionActivityRow,
} from "@/server/attribution/conversions";

/**
 * 016 — As peças puras do relatório de conversões e dois guardrails que
 * se leem do código-fonte porque afirmam AUSÊNCIA (que algo não é chamado),
 * e isso não se observa de fora.
 */

describe("purchaseCustomData", () => {
  it("convierte centavos a unidades de la moneda", () => {
    // O banco protege o dinheiro em centavos inteiros; a Meta espera unidades.
    expect(purchaseCustomData({ amountCents: 45050, currency: "MXN" })).toEqual({
      lead_stage: "won",
      value: 450.5,
      currency: "MXN",
    });
  });

  it("sin monto, la venta se cuenta pero SIN precio", () => {
    // `value: 0` não significa "não sei quanto": ensinaria ao otimizador que
    // as vendas deste negócio não valem nada.
    expect(purchaseCustomData({ amountCents: null, currency: "MXN" })).toEqual({
      lead_stage: "won",
    });
    expect(purchaseCustomData({ amountCents: 0, currency: "MXN" })).toEqual({
      lead_stage: "won",
    });
  });

  it("un monto negativo tampoco inventa un valor", () => {
    expect(purchaseCustomData({ amountCents: -100, currency: "MXN" })).toEqual({
      lead_stage: "won",
    });
  });

  it("sin moneda capturada, manda el valor sin moneda antes que inventarla", () => {
    expect(purchaseCustomData({ amountCents: 12300, currency: null })).toEqual({
      lead_stage: "won",
      value: 123,
    });
  });
});

describe("toConversionActivityRow", () => {
  const base = {
    id: "cve_1",
    conversationId: "cv_1",
    eventName: "QualifiedLead",
    error: null,
    fbTraceId: "Aki1",
    contactName: "Marina",
    adHeadline: "Kit de verano",
    createdAt: new Date("2026-08-28T10:00:00.000Z"),
  };

  it("muestra el momento del ENVÍO cuando lo hubo", () => {
    const row = toConversionActivityRow({
      ...base,
      status: "sent",
      sentAt: new Date("2026-08-28T10:05:00.000Z"),
    });
    expect(row.at).toBe("2026-08-28T10:05:00.000Z");
    expect(row.adHeadline).toBe("Kit de verano");
  });

  it("y el de creación cuando no salió", () => {
    const row = toConversionActivityRow({
      ...base,
      status: "skipped",
      sentAt: null,
      error: "sin ctwa_clid",
    });
    expect(row.at).toBe("2026-08-28T10:00:00.000Z");
    // O motivo se conserva como está: é a resposta a "por que este lead não
    // aparece na Meta?".
    expect(row.error).toBe("sin ctwa_clid");
  });
});

describe("guardarraíles del reporte", () => {
  const source = readFileSync("src/server/attribution/conversions.ts", "utf8");

  it("una conversación de prueba jamás puede producir un evento", () => {
    // Mesmo guardrail do sender: o Laboratório não toca o mundo real.
    expect(source).toContain("eq(schema.conversation.isTest, false)");
  });

  it("el dedup es el UNIQUE de la base, no un chequeo previo", () => {
    // Não se consegue desenviar uma compra na Meta: dois movimentos simultâneos
    // do mesmo lead têm que colidir no banco, não num `if`.
    expect(source).toContain("onConflictDoNothing");
  });

  it("la emisión cuelga de la puerta única de etapas", () => {
    const gate = readFileSync("src/server/leads/stage-history.ts", "utf8");
    expect(gate).toContain("reportStageChange");
    // E acontece DEPOIS do commit: uma chamada de rede dentro da transação
    // a manteria aberta enquanto a Meta pensa.
    const txEnd = gate.indexOf("  });");
    expect(gate.indexOf("reportStageChange(", txEnd)).toBeGreaterThan(txEnd);
  });
});
