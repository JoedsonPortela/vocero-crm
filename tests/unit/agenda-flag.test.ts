import { describe, expect, it } from "vitest";
import { parseAgendaFlag } from "@/server/agenda/flag";

/**
 * 015 — A flag da agenda. O caso que importa é o DEFAULT: uma
 * instância que não a pediu não deve acabar com a agenda ligada por um
 * descuido de configuração.
 */

describe("parseAgendaFlag", () => {
  it("sin variable, la agenda no existe", () => {
    expect(parseAgendaFlag(undefined)).toBe(false);
    expect(parseAgendaFlag("")).toBe(false);
    expect(parseAgendaFlag("   ")).toBe(false);
  });

  it("`on` la enciende, con espacios y mayúsculas de por medio", () => {
    expect(parseAgendaFlag("on")).toBe(true);
    expect(parseAgendaFlag("ON")).toBe(true);
    expect(parseAgendaFlag("  On  ")).toBe(true);
  });

  it("acepta las otras formas de decir que sí", () => {
    expect(parseAgendaFlag("1")).toBe(true);
    expect(parseAgendaFlag("true")).toBe(true);
    expect(parseAgendaFlag("TRUE")).toBe(true);
    expect(parseAgendaFlag("si")).toBe(true);
    expect(parseAgendaFlag("sí")).toBe(true);
    expect(parseAgendaFlag("yes")).toBe(true);
  });

  it("cualquier otra cosa deja la agenda apagada, incluido `off` y `false`", () => {
    expect(parseAgendaFlag("off")).toBe(false);
    expect(parseAgendaFlag("false")).toBe(false);
    expect(parseAgendaFlag("0")).toBe(false);
    expect(parseAgendaFlag("no")).toBe(false);
    expect(parseAgendaFlag("agenda")).toBe(false);
    // Um erro de digitação não liga nada: desligada é o estado seguro.
    expect(parseAgendaFlag("onn")).toBe(false);
  });
});
