import { describe, expect, it } from "vitest";
import { agentActionSchema } from "@/server/ai/actions";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import { aiMockCompletion } from "@/server/dev/ai-mock";

/**
 * R11 — O ai-mock reflete o que o prompt lhe ensina. Com a agenda desligada
 * respondia `offer_slots` a "quiero una cita", o esquema do turno o
 * rejeitava e o self-test terminava em "Error del proveedor de IA": testava
 * algo que em produção não acontece.
 */

type Profile = Parameters<typeof buildAgentSystemPrompt>[0]["profile"];
const profile = {
  name: "Nea",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
} as unknown as Profile;

function turno(agenda: boolean, texto: string) {
  const system = buildAgentSystemPrompt({ profile, kb: [], stages: [{ name: "Novo" }], agenda });
  const raw = aiMockCompletion([
    { role: "system", content: system },
    { role: "user", content: texto },
  ]);
  return agentActionSchema(agenda).safeParse(JSON.parse(raw));
}

describe("ai-mock y la bandera AGENDA", () => {
  it("apagada: pedir cita NO produce offer_slots y el turno es válido", () => {
    const r = turno(false, "Hola, ¿dan citas el sábado?");
    expect(r.success).toBe(true);
    expect(r.data?.action).not.toBe("offer_slots");
  });

  it("encendida: pedir cita sigue ofreciendo horarios", () => {
    const r = turno(true, "Hola, ¿dan citas el sábado?");
    expect(r.success).toBe(true);
    expect(r.data?.action).toBe("offer_slots");
  });
});
