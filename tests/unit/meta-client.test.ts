import { describe, expect, it } from "vitest";
import { MetaApiError, normalizeMx, normalizeRecipient } from "@/lib/meta/client";

describe("normalizeRecipient", () => {
  it("México móvil legado: 521 + 10 dígitos → 52 + 10 dígitos", () => {
    expect(normalizeRecipient("5215512345678")).toBe("525512345678");
  });

  it("México ya normalizado queda intacto", () => {
    expect(normalizeRecipient("525512345678")).toBe("525512345678");
  });

  it("Argentina móvil: 549 + 10 dígitos → 54 + 10 dígitos (issue #35)", () => {
    // A Meta reporta `549…`, mas a lista de destinatários de teste só
    // aceita o número sem o 9: com o 9 responde 131030 e o painel mostra
    // o número como habilitado, então o erro manda revisar onde não é.
    expect(normalizeRecipient("5491122334455")).toBe("541122334455");
  });

  it("Argentina ya normalizada queda intacta", () => {
    expect(normalizeRecipient("541122334455")).toBe("541122334455");
  });

  it("otros países quedan intactos", () => {
    expect(normalizeRecipient("14155552671")).toBe("14155552671");
    expect(normalizeRecipient("50761234567")).toBe("50761234567");
  });

  it("no confunde números que empiezan en el troncal pero con otra longitud", () => {
    expect(normalizeRecipient("521123")).toBe("521123");
    expect(normalizeRecipient("549123")).toBe("549123");
    // 549 + 11 dígitos não é um celular argentino: não se mexe.
    expect(normalizeRecipient("54911223344556")).toBe("54911223344556");
  });

  it("la identidad NO se toca: normalizar al enviar es asimétrico a propósito", () => {
    // Se a ingestão reescrevesse `549…`, a identidade salva deixaria de
    // coincidir com o `wa_id` de cada webhook e o contato se partiria.
    expect(normalizeMx("5491122334455")).toBe("5491122334455");
  });
});

describe("MetaApiError.isAuthError", () => {
  it("status 401 es error de auth", () => {
    expect(new MetaApiError("x", { status: 401 }).isAuthError).toBe(true);
  });

  it("code 190 es error de auth (token vencido)", () => {
    expect(new MetaApiError("x", { status: 400, code: 190 }).isAuthError).toBe(
      true
    );
  });

  it("OAuthException solo NO basta (Meta la usa en errores transitorios)", () => {
    // Incidente 2026-08-03: um 500 com type OAuthException (código 2,
    // "service temporarily unavailable") marcava o token como vencido e
    // bloqueava TODO envio. O type sozinho jamais decide.
    expect(
      new MetaApiError("x", { status: 400, type: "OAuthException" }).isAuthError
    ).toBe(false);
    expect(
      new MetaApiError("x", { status: 500, code: 2, type: "OAuthException" })
        .isAuthError
    ).toBe(false);
  });

  it("OAuthException con código 190 sí es error de auth", () => {
    expect(
      new MetaApiError("x", { status: 400, code: 190, type: "OAuthException" })
        .isAuthError
    ).toBe(true);
  });

  it("un 5xx JAMÁS es error de auth, ni con código 190", () => {
    expect(new MetaApiError("x", { status: 500 }).isAuthError).toBe(false);
    expect(
      new MetaApiError("x", { status: 500, code: 190 }).isAuthError
    ).toBe(false);
  });
});
