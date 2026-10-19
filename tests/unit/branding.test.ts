import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  accentCssVariables,
  DEFAULT_BRANDING,
  isValidHex,
  normalizeBranding,
  resolveAccentSet,
  resolveNavAccentSet,
} from "@/lib/branding";

const DARK_BG = "#1c263c";
const NAV_BG = "#0b1327";

/** Contraste WCAG entre dois hex, para afirmar sobre legibilidade e não sobre
 *  valores concretos: o que importa é que se LEIA, não que dê certa cor. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const ch = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [l1, l2] = [lum(a), lum(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Variáveis de um bloco de globals.css, com o valor sem quebras de linha. */
function variables(css: string, selector: string): Record<string, string> {
  const inicio = css.indexOf(selector);
  expect(inicio, `no está el bloque ${selector}`).toBeGreaterThanOrEqual(0);
  const cuerpo = css
    .slice(css.indexOf("{", inicio) + 1, css.indexOf("}", inicio))
    .replace(/\/\*[\s\S]*?\*\//g, ""); // um comentário pode nomear um token
  return Object.fromEntries(
    [...cuerpo.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.replace(/\s+/g, " ").trim(),
    ])
  );
}

describe("white-label: acento", () => {
  it("preset devuelve el set exacto del handoff", () => {
    expect(resolveAccentSet("#3f5972")).toEqual(ACCENT_PRESETS["#3f5972"]!.set);
    expect(resolveAccentSet("#5f5470").soft).toBe("#e6e1ec");
  });

  it("color personalizado deriva hover/soft/tint/text", () => {
    const s = resolveAccentSet("#7a3b5e");
    expect(isValidHex(s.hover)).toBe(true);
    expect(isValidHex(s.soft)).toBe(true);
    expect(isValidHex(s.tint)).toBe(true);
    expect(s.hover).not.toBe(s.accent);
  });

  it("color demasiado claro se oscurece para contraste con texto blanco", () => {
    const s = resolveAccentSet("#ffee88"); // amarelo pálido, ilegível com branco
    expect(s.accent).not.toBe("#ffee88");
    // o resultado deve ser notavelmente mais escuro
    const lum = parseInt(s.accent.slice(1, 3), 16);
    expect(lum).toBeLessThan(0xd0);
  });

  it("hex inválido cae al default (el azul Vocero)", () => {
    expect(resolveAccentSet("rojo")).toEqual(ACCENT_PRESETS["#0d5bff"]!.set);
  });

  it("el azul Vocero es el default y trae los valores exactos de la landing", () => {
    expect(DEFAULT_BRANDING.accent).toBe("#0d5bff");
    expect(resolveAccentSet(DEFAULT_BRANDING.accent)).toEqual({
      accent: "#0d5bff",
      hover: "#0a4de6",
      soft: "#d3e2ff",
      tint: "#ebf1ff",
      text: "#0038d8",
      fg: "#ffffff",
    });
  });
});

describe("white-label: acento en tema oscuro", () => {
  it("un acento pensado para fondo blanco se aclara hasta despegarse del fondo", () => {
    // Azul profundo: sobre o azul-marinho da página quase não se vê.
    const oscuro = resolveAccentSet("#12305a", "dark");
    expect(contrast("#12305a", DARK_BG)).toBeLessThan(3);
    expect(contrast(oscuro.accent, DARK_BG)).toBeGreaterThanOrEqual(3);
  });

  it("la tinta del botón pasa AA sobre el acento ya aclarado", () => {
    for (const hex of ["#12305a", "#3f5972", "#ffee88", "#7a3b5e"]) {
      const s = resolveAccentSet(hex, "dark");
      expect(contrast(s.fg, s.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("el azul Vocero conserva la tinta blanca en oscuro", () => {
    expect(resolveAccentSet(DEFAULT_BRANDING.accent, "dark").fg).toBe("#ffffff");
  });

  it("los presets NO se aplican tal cual: están calculados para fondo blanco", () => {
    const claro = resolveAccentSet("#3f5972", "light");
    const oscuro = resolveAccentSet("#3f5972", "dark");
    expect(oscuro.accent).not.toBe(claro.accent);
    // soft e tint se misturam para o fundo escuro, não para o branco
    expect(contrast(oscuro.tint, DARK_BG)).toBeLessThan(2);
  });

  it("hex inválido en oscuro también cae al acento por defecto", () => {
    expect(resolveAccentSet("rojo", "dark")).toEqual(
      resolveAccentSet("#0d5bff", "dark")
    );
  });

  it("el CSS inyectado trae los DOS temas: el botón cambia sin recargar", () => {
    const css = accentCssVariables("#3f5972");
    expect(css).toContain(":root:root{");
    expect(css).toContain(':root:root[data-theme="dark"]{');
    expect(css).toContain(resolveAccentSet("#3f5972", "light").accent);
    expect(css).toContain(resolveAccentSet("#3f5972", "dark").accent);
  });

  it("el fondo de referencia del cálculo sigue al de globals.css", () => {
    // DARK_BG e NAV_BG vivem duplicados em branding.ts porque o cálculo de
    // contraste é JS e o token é CSS. Se alguém muda um fundo e não o
    // outro, os acentos são calculados contra um fundo que já não existe.
    const css = readFileSync("src/app/globals.css", "utf8");
    const dark = variables(css, ':root[data-theme="dark"] {');
    expect(dark["--bg"]?.toLowerCase()).toBe(DARK_BG);
    expect(variables(css, ".nav-dark {")["--bg"]?.toLowerCase()).toBe(NAV_BG);
    // …e o cálculo de verdade os usa: o preenchimento se destaca de cada um.
    expect(contrast(resolveAccentSet("#12305a", "dark").accent, DARK_BG)).toBeGreaterThanOrEqual(3);
    expect(contrast(resolveNavAccentSet("#12305a").accent, NAV_BG)).toBeGreaterThanOrEqual(3.5);
  });
});

describe("white-label: barra lateral bicolor (.nav-dark)", () => {
  it("la barra lleva SIEMPRE el acento calculado contra su propio fondo", () => {
    // É azul-marinho mesmo com a página em claro: com o acento do tema
    // claro, uma cor pensada para fundo branco afundaria nela.
    const css = accentCssVariables("#3f5972");
    const nav = /\.nav-dark\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(nav).toContain(`--accent:${resolveNavAccentSet("#3f5972").accent};`);
    expect(nav).toContain(`--accent-fg:${resolveNavAccentSet("#3f5972").fg};`);
    expect(nav).not.toContain(resolveAccentSet("#3f5972", "light").accent);
  });

  it("con el azul Vocero, la barra se ve como siempre", () => {
    // A receita da barra é a de antes: o item ativo do tema claro não
    // muda mesmo que o tema escuro da página mude.
    expect(resolveNavAccentSet(DEFAULT_BRANDING.accent)).toEqual({
      accent: "#256bff",
      hover: "#4883ff",
      soft: "#122c63",
      tint: "#0e1e41",
      text: "#6295ff",
      fg: "#ffffff",
    });
  });

  it("sus neutros son SUYOS: no copian al tema oscuro de la página", () => {
    // Antes `.nav-dark` repetia o bloco escuro e barra e página ficavam em
    // 1.04:1. Agora a página sobe um degrau; se alguém voltar a
    // igualá-las, o bicolor desaparece no escuro: aqui isso cai.
    const css = readFileSync("src/app/globals.css", "utf8");
    const oscuro = variables(css, ':root[data-theme="dark"] {');
    const nav = variables(css, ".nav-dark {");
    expect(Object.keys(nav)).toEqual(
      expect.arrayContaining(["--bg", "--bg-subtle", "--text", "--text-3", "--border"])
    );
    expect(nav["--bg-subtle"]).not.toBe(oscuro["--bg-subtle"]);
    expect(nav["--bg"]).not.toBe(oscuro["--bg"]);
  });
});

describe("tema oscuro: las superficies se distinguen", () => {
  // Com os tokens de antes, lista, fio e barra eram três azuis-marinho quase
  // iguais: bordas a 1.26:1 do fundo e chips da mesma cor que a sua linha.
  // Afirma-se sobre legibilidade, não sobre um hex: quem retocar o tema
  // escuro pode mover os valores, não o piso.
  const css = readFileSync("src/app/globals.css", "utf8");
  const oscuro = variables(css, ':root[data-theme="dark"] {');
  const claro = variables(css, ":root {");
  const tono = (nombre: string) => oscuro[nombre] ?? `falta ${nombre}`;

  it("los bordes separan las columnas: ≥ 1.6:1 contra el fondo", () => {
    expect(contrast(tono("--border"), tono("--bg"))).toBeGreaterThanOrEqual(1.6);
    expect(contrast(tono("--border-strong"), tono("--bg"))).toBeGreaterThan(
      contrast(tono("--border"), tono("--bg"))
    );
  });

  it("el chip y la fila bajo el cursor se ACLARAN respecto al fondo", () => {
    // Contra --bg, que é o da lista: um chip ou um hover mais escuros se
    // leem como um buraco, não como uma superfície.
    const blanco = "#ffffff";
    for (const nombre of ["--chip-bg", "--row-hover", "--bg-hover"]) {
      expect(contrast(tono(nombre), blanco), nombre).toBeLessThan(
        contrast(tono("--bg"), blanco)
      );
    }
  });

  it("en claro, chips y hover se ven igual que antes", () => {
    expect(claro["--chip-bg"]).toBe(claro["--bg"]);
    expect(claro["--row-hover"]).toBe(claro["--bg-subtle"]);
  });
});

describe("white-label: normalización", () => {
  it("nombre vacío o nulo → default 'Vocero'; se recorta a 30", () => {
    expect(normalizeBranding(null).name).toBe("Vocero");
    expect(normalizeBranding({ name: "   " }).name).toBe("Vocero");
    expect(normalizeBranding({ name: "x".repeat(50) }).name).toHaveLength(30);
  });

  it("acento inválido → default", () => {
    expect(normalizeBranding({ accent: "azul" }).accent).toBe("#0d5bff");
    expect(normalizeBranding({ accent: "#3F6B66" }).accent).toBe("#3f6b66");
  });
});
