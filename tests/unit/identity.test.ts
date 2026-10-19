import { describe, expect, it } from "vitest";
import { normalizeMx } from "@/lib/meta/client";
import { BSUID_PREFIX, resolveIdentity } from "@/server/inbox/identity";
import type { WebhookMessage, WebhookValue } from "@/server/inbox/webhook";

/** Feature 003: identidade resiliente de contato (BSUID). */

function msg(partial: Partial<WebhookMessage>): WebhookMessage {
  return { id: "wamid.test.1", timestamp: "1752800000", type: "text", ...partial };
}

describe("normalizeMx (simétrica ingest/envío)", () => {
  it("troncal MX 521 + 10 dígitos → 52 + 10 dígitos", () => {
    expect(normalizeMx("5215550001234")).toBe("525550001234");
  });

  it("52 + 10 dígitos queda igual", () => {
    expect(normalizeMx("525550001234")).toBe("525550001234");
  });

  it("otros países quedan intactos", () => {
    expect(normalizeMx("5491122334455")).toBe("5491122334455");
    expect(normalizeMx("14155551212")).toBe("14155551212");
    expect(normalizeMx("50761234567")).toBe("50761234567");
  });
});

describe("resolveIdentity: teléfono presente", () => {
  const contacts: WebhookValue["contacts"] = [
    { wa_id: "5215550001234", profile: { name: "Kevin" } },
  ];

  it("usa el teléfono NORMALIZADO como identidad", () => {
    const r = resolveIdentity(msg({ from: "5215550001234" }), contacts);
    expect(r).not.toBeNull();
    expect(r!.identity).toBe("525550001234");
    expect(r!.phone).toBe("525550001234");
    expect(r!.profileName).toBe("Kevin");
  });

  it("521 y 52 resuelven a la MISMA identidad (dedup del bug MX)", () => {
    const a = resolveIdentity(msg({ from: "5215550001234" }), contacts);
    const b = resolveIdentity(msg({ from: "525550001234" }), []);
    expect(a!.identity).toBe(b!.identity);
  });

  it("captura el BSUID si además viene user_id", () => {
    const r = resolveIdentity(msg({ from: "5215550001234" }), [
      { wa_id: "5215550001234", user_id: "bsu_777", profile: { name: "Kevin" } },
    ]);
    expect(r!.waUserId).toBe("bsu_777");
    expect(r!.identity).toBe("525550001234"); // o telefone manda se existir
  });
});

describe("resolveIdentity: sin wa_id (mundo BSUID)", () => {
  it("from_user_id en el mensaje → identidad bsuid:", () => {
    const r = resolveIdentity(msg({ from_user_id: "bsu_123" }), [
      { user_id: "bsu_123", profile: { name: "Dueña Dental" } },
    ]);
    expect(r).not.toBeNull();
    expect(r!.identity).toBe(`${BSUID_PREFIX}bsu_123`);
    expect(r!.phone).toBeNull();
    expect(r!.waUserId).toBe("bsu_123");
    expect(r!.profileName).toBe("Dueña Dental");
  });

  it("user_id solo en contacts[] también resuelve", () => {
    const r = resolveIdentity(msg({}), [
      { user_id: "bsu_456", profile: { name: "Cliente" } },
    ]);
    expect(r).not.toBeNull();
    expect(r!.identity).toBe(`${BSUID_PREFIX}bsu_456`);
  });

  it("sin from y sin user_id → null (descartar con log, no reventar)", () => {
    expect(resolveIdentity(msg({}), [])).toBeNull();
    expect(resolveIdentity(msg({}), undefined)).toBeNull();
  });

  it("el nombre de perfil no cae al identificador crudo", () => {
    const r = resolveIdentity(msg({ from_user_id: "bsu_123" }), []);
    // Sem perfil: profileName null — o fallback de exibição é decidido ao criar
    // o contato (nunca o BSUID cru).
    expect(r!.profileName).toBeNull();
  });
});
