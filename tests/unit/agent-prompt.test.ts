import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt, TURN_FORMAT_REMINDER } from "@/server/ai/prompts";
import { aiMockCompletion } from "@/server/dev/ai-mock";
import { agentActionSchema } from "@/server/ai/actions";

/**
 * 029 — O agente não fica calado diante de uma saudação. O que o modelo faz
 * com o prompt se mede contra o modelo real em `scripts/eval-silencios.mjs`;
 * aqui se fixa que o prompt diz o que essa medição precisa.
 */

type Profile = Parameters<typeof buildAgentSystemPrompt>[0]["profile"];
const profile = {
  name: "Sofía",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
} as unknown as Profile;

const prompt = (agenda: boolean) =>
  buildAgentSystemPrompt({ profile, kb: [], stages: [{ name: "Novo" }], agenda });

describe.each([false, true])("prompt del agente (agenda %s)", (agenda) => {
  const p = prompt(agenda);
  const linea = (accion: string) =>
    p.split("\n").find((l) => l.startsWith(`- {"action":"${accion}"`)) ?? "";

  it("callar solo cuando el cliente cierra", () => {
    expect(linea("none")).toMatch(/SOLO cuando el último mensaje del cliente cierra/);
    expect(linea("none")).not.toBe('- {"action":"none"} — no responder nada.');
  });

  it("un saludo, un mensaje raro o una prueba se contestan", () => {
    expect(p).toMatch(/Todo mensaje del cliente que no sea un cierre recibe respuesta/);
    expect(p).toMatch(/Nunca supongas que es una prueba/);
  });

  it("la nota y el cambio de etapa no sustituyen la respuesta", () => {
    expect(linea("update_lead")).toMatch(/si el cliente espera respuesta, incluye reply/);
    expect(linea("move_stage")).toMatch(/si el cliente espera respuesta, incluye reply/);
  });
});

describe("recordatorio de formato al final del turno", () => {
  it("pide el JSON de una acción", () => {
    expect(TURN_FORMAT_REMINDER).toMatch(/UN objeto JSON de acción/);
  });

  it("el ai-mock sigue contestando con él al final", () => {
    const raw = aiMockCompletion([
      { role: "system", content: prompt(false) },
      { role: "user", content: "Hola prueba 1" },
      { role: "system", content: TURN_FORMAT_REMINDER },
    ]);
    expect(agentActionSchema(false).safeParse(JSON.parse(raw)).success).toBe(true);
  });
});
