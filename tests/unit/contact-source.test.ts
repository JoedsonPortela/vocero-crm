import { describe, expect, it } from "vitest";
import {
  effectiveSource,
  isSourceValue,
  SOURCE_LABELS,
  SOURCE_VALUES,
} from "@/server/contact-source";

/* Fonte do prospect: o que foi capturado manda, o resto fica sem identificar. */

describe("fuente efectiva", () => {
  it("lo que capturó el dueño se marca como capturado", () => {
    expect(effectiveSource("referido")).toEqual({
      value: "referido",
      source: "capturada",
    });
  });

  it("sin captura queda desconocida, y se dice que fue deducida", () => {
    // Não se inventa: um contato que só escreveu pelo WhatsApp não diz de
    // onde saiu, e apresentá-lo como dado seria mentir no relatório.
    expect(effectiveSource(null)).toEqual({
      value: "desconocida",
      source: "deducida",
    });
  });

  it("nunca inventa: 'desconocida' no es un valor capturable", () => {
    expect(isSourceValue("desconocida")).toBe(false);
    expect(SOURCE_VALUES).not.toContain("desconocida");
  });
});

describe("catálogo de fuentes", () => {
  it("es cerrado y cubre lo que el dueño pidió", () => {
    expect([...SOURCE_VALUES].sort()).toEqual(
      ["anuncio", "conocido", "organico", "otro", "referido"].sort()
    );
  });

  it("toda fuente tiene etiqueta legible, incluida la desconocida", () => {
    for (const v of [...SOURCE_VALUES, "desconocida" as const]) {
      expect(SOURCE_LABELS[v]).toBeTruthy();
    }
  });

  it("valida entradas basura", () => {
    expect(isSourceValue("facebook")).toBe(false);
    expect(isSourceValue(null)).toBe(false);
    expect(isSourceValue("referido")).toBe(true);
  });
});
