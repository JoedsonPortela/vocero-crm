import { describe, expect, it } from "vitest";
import { parseAtribucionFlag } from "@/server/attribution/flag";

/**
 * 016 — A flag da atribuição. O caso que importa é o DEFAULT: uma
 * instância que não a pediu não deve acabar guardando identificadores de clique
 * da Meta nem mandando eventos por um descuido de configuração.
 */

describe("parseAtribucionFlag", () => {
  it("sin variable, la atribución no existe", () => {
    expect(parseAtribucionFlag(undefined)).toBe(false);
    expect(parseAtribucionFlag("")).toBe(false);
    expect(parseAtribucionFlag("   ")).toBe(false);
  });

  it("`on` la enciende, con espacios y mayúsculas de por medio", () => {
    expect(parseAtribucionFlag("on")).toBe(true);
    expect(parseAtribucionFlag("ON")).toBe(true);
    expect(parseAtribucionFlag("  On  ")).toBe(true);
  });

  it("acepta las otras formas de decir que sí", () => {
    expect(parseAtribucionFlag("1")).toBe(true);
    expect(parseAtribucionFlag("true")).toBe(true);
    expect(parseAtribucionFlag("si")).toBe(true);
    expect(parseAtribucionFlag("sí")).toBe(true);
    expect(parseAtribucionFlag("yes")).toBe(true);
  });

  it("cualquier otra cosa la deja apagada, incluido `off` y `false`", () => {
    expect(parseAtribucionFlag("off")).toBe(false);
    expect(parseAtribucionFlag("false")).toBe(false);
    expect(parseAtribucionFlag("0")).toBe(false);
    expect(parseAtribucionFlag("no")).toBe(false);
    // Um erro de digitação não liga nada: desligada é o estado seguro.
    expect(parseAtribucionFlag("onn")).toBe(false);
  });
});
