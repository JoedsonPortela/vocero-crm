import { describe, expect, it } from "vitest";

/**
 * 003 / #51 — Quando o nome de um contato é atualizado.
 *
 * Era definido SOMENTE ao criá-lo, então quem mudava seu nome do WhatsApp
 * continuava aparecendo com o antigo para sempre (relatado por @federicorv25:
 * mudou de «Federico» para «Federicoso» e o CRM não percebeu).
 *
 * Mas atualizá-lo sempre quebraria outra coisa: o operador que renomeou
 * alguém como «Juan - obra Polanco» perderia esse trabalho com a próxima
 * mensagem. Daí o `nameSource`.
 *
 * A decisão se testa como TABELA e sem banco de dados: é uma regra de
 * negócio, e enterrá-la num teste de integração a tornaria invisível.
 */

/** A regra, tal qual a aplica `getOrCreateContactByIdentity`. */
function nombreNuevo(
  actual: { name: string; nameSource: "perfil" | "manual" },
  perfil: string | null
): string | null {
  const delPerfil = perfil?.trim();
  if (!delPerfil) return null;
  if (actual.nameSource !== "perfil") return null;
  if (delPerfil === actual.name) return null;
  return delPerfil;
}

describe("el nombre que trae WhatsApp", () => {
  it("actualiza un nombre que vino del perfil (el caso reportado)", () => {
    expect(
      nombreNuevo({ name: "Federico", nameSource: "perfil" }, "Federicoso")
    ).toBe("Federicoso");
  });

  it("NO toca un nombre que escribió una persona", () => {
    expect(
      nombreNuevo(
        { name: "Juan - obra Polanco", nameSource: "manual" },
        "Juan"
      )
    ).toBeNull();
  });

  it("sin nombre de perfil no hay nada que hacer", () => {
    expect(nombreNuevo({ name: "Federico", nameSource: "perfil" }, null)).toBeNull();
    expect(nombreNuevo({ name: "Federico", nameSource: "perfil" }, "   ")).toBeNull();
  });

  /**
   * Sem isso, cada mensagem gravaria o mesmo nome outra vez e moveria
   * `updated_at`: ruído no banco e em qualquer coisa que ordene por ele.
   */
  it("el mismo nombre no genera escritura", () => {
    expect(
      nombreNuevo({ name: "Federico", nameSource: "perfil" }, "Federico")
    ).toBeNull();
  });

  it("recorta los espacios que manda WhatsApp", () => {
    expect(
      nombreNuevo({ name: "Federico", nameSource: "perfil" }, "  Federicoso  ")
    ).toBe("Federicoso");
  });
});
