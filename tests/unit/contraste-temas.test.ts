import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  DEFAULT_BRANDING,
  resolveAccentSet,
  resolveNavAccentSet,
} from "@/lib/branding";

/**
 * R8 — Pisos de contraste dos dois temas, medidos sobre os tokens REAIS de
 * globals.css (não sobre uma cópia). O tema escuro de antes passava em todos os
 * testes e mesmo assim parecia chapado: barra e página a 1.04:1, chip e painel a
 * 1.01:1. Aqui vive cada par que importa com seu piso, para que um retoque de
 * cor que o quebre estoure em `pnpm test` e não numa captura.
 *
 * Pisos: texto de leitura ≥ 4.5:1 (WCAG AA); ícones, preenchimentos e anel de
 * foco ≥ 3:1 (1.4.11); e para superfícies e bordas, o degrau mínimo que se
 * consegue ver (≈ 1.1–1.25:1 entre superfícies, ≥ 1.4:1 uma borda).
 */

type Vars = Record<string, string>;

function luminancia(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contraste(a: string, b: string): number {
  const [l1, l2] = [luminancia(a), luminancia(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Variáveis de um bloco de globals.css, com o valor sem quebras de linha. */
function bloque(css: string, selector: string): Vars {
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

const css = readFileSync("src/app/globals.css", "utf8");
const claro = bloque(css, ":root {");
const oscuroCrudo = bloque(css, ':root[data-theme="dark"] {');
const nav = bloque(css, ".nav-dark {");

/** Tokens do tema escuro: o que o bloco não redeclara vem de `:root`. */
const oscuro: Vars = { ...claro, ...oscuroCrudo };

/** Resolve `var(--x)` contra o mesmo bloco (um nível basta aqui). */
function hex(vars: Vars, nombre: string): string {
  const v = vars[nombre];
  expect(v, `falta ${nombre}`).toBeDefined();
  const ref = /^var\((--[\w-]+)\)$/.exec(v!)?.[1];
  const valor = ref ? vars[ref] : v;
  expect(valor, `${nombre} no es un hex`).toMatch(/^#[0-9a-f]{6}$/i);
  return valor!.toLowerCase();
}

/** Afirma um piso com uma mensagem que diz o par e seu valor. */
function piso(vars: Vars, a: string, b: string, min: number) {
  const c = contraste(hex(vars, a), hex(vars, b));
  expect(c, `${a} sobre ${b}: ${c.toFixed(2)} (piso ${min})`).toBeGreaterThanOrEqual(min);
}

/** `a` é a superfície MAIS CLARA das duas. */
function arriba(vars: Vars, a: string, b: string) {
  expect(
    luminancia(hex(vars, a)),
    `${a} debería ir un escalón arriba de ${b}`
  ).toBeGreaterThan(luminancia(hex(vars, b)));
}

describe("tema oscuro: el bicolor no desaparece", () => {
  it("la barra es claramente más oscura que la página (≥ 1.25:1)", () => {
    // A barra pinta `bg-subtle` DENTRO de `.nav-dark`; a página, `--bg`.
    const barra = hex(nav, "--bg-subtle");
    const pagina = hex(oscuro, "--bg");
    expect(luminancia(barra)).toBeLessThan(luminancia(pagina));
    expect(contraste(barra, pagina)).toBeGreaterThanOrEqual(1.25);
    // …e o vão da página (fio, colunas) também não se confunde com ela.
    expect(contraste(barra, hex(oscuro, "--bg-subtle"))).toBeGreaterThanOrEqual(1.1);
  });

  it("en claro la barra sigue siendo azul marino sobre blanco", () => {
    expect(contraste(hex(nav, "--bg-subtle"), hex(claro, "--bg"))).toBeGreaterThanOrEqual(15);
  });
});

describe("tema oscuro: escalera de superficies", () => {
  it("hueco < página < fila bajo el cursor ≈ lo que flota < chip < panel < hover", () => {
    arriba(oscuro, "--bg", "--bg-subtle");
    arriba(oscuro, "--row-hover", "--bg");
    arriba(oscuro, "--bg-raised", "--bg");
    arriba(oscuro, "--chip-bg", "--row-hover");
    arriba(oscuro, "--bg-panel", "--chip-bg");
    arriba(oscuro, "--bg-panel", "--bg-raised");
    arriba(oscuro, "--bg-hover", "--bg-panel");
  });

  it("cada escalón se ve", () => {
    piso(oscuro, "--bg", "--bg-subtle", 1.1);
    piso(oscuro, "--row-hover", "--bg", 1.07);
    piso(oscuro, "--bg-raised", "--bg", 1.08);
    // Um botão secundário (bg-secondary) dentro de um diálogo ou uma gaveta.
    piso(oscuro, "--bg-panel", "--bg-raised", 1.1);
    piso(oscuro, "--bg-panel", "--bg", 1.2);
    piso(oscuro, "--chip-bg", "--bg", 1.15);
    piso(oscuro, "--chip-bg", "--row-hover", 1.07);
    piso(oscuro, "--bg-hover", "--bg", 1.35);
    // O contador dentro de um chip de filtro (bg-secondary sobre bg-chip):
    // antes 1.01:1, o círculo não se via.
    piso(oscuro, "--bg-panel", "--chip-bg", 1.1);
    // Como no claro (1.03:1), o hover de um botão secundário é sutil.
    piso(oscuro, "--bg-hover", "--bg-panel", 1.05);
    piso(oscuro, "--bg-hover", "--bg-raised", 1.25);
    // 215 — o horário não útil contra a grade (bg-card = --bg).
    piso(oscuro, "--bg", "--cal-off", 1.08);
  });

  it("los bordes separan (≥ 1.6:1 en la página, ≥ 1.4:1 en lo que flota)", () => {
    piso(oscuro, "--border", "--bg", 1.6);
    piso(oscuro, "--border", "--bg-subtle", 1.5);
    piso(oscuro, "--border", "--bg-raised", 1.4);
    piso(oscuro, "--border-strong", "--bg", 2.2);
    piso(oscuro, "--border-strong", "--bg-raised", 2);
  });

  it("las burbujas se despegan del hilo", () => {
    piso(oscuro, "--bubble-in", "--chat-bg", 1.3);
    piso(oscuro, "--bubble-in-border", "--chat-bg", 2);
    piso(oscuro, "--accent-tint", "--chat-bg", 1.3); // --bubble-out
    piso(oscuro, "--text", "--bubble-in", 7);
    piso(oscuro, "--text", "--accent-tint", 7);
  });
});

describe("tema oscuro: texto", () => {
  const superficies = [
    "--bg-subtle",
    "--bg",
    "--row-hover",
    "--bg-raised",
    "--bg-panel",
    "--chip-bg",
    "--bg-hover",
    "--accent-tint",
  ];

  it("texto, secundario y terciario pasan AA sobre TODA superficie", () => {
    // `text-3` incluído: é o da `.kicker` (10.5px) e das horas.
    for (const s of superficies) {
      piso(oscuro, "--text", s, 7);
      piso(oscuro, "--text-2", s, 4.5);
      piso(oscuro, "--text-3", s, 4.5);
    }
  });

  it("text-4 alcanza para iconos (≥ 3:1), no para leer", () => {
    for (const s of ["--bg", "--bg-raised", "--bg-panel", "--accent-tint"]) {
      piso(oscuro, "--text-4", s, 3);
    }
  });

  it("las tríadas de estado se leen sobre su propio fondo", () => {
    for (const e of ["success", "warning", "danger", "info"]) {
      piso(oscuro, `--${e}-text`, `--${e}-tint`, 4.5);
      piso(oscuro, `--${e}-text`, "--bg", 4.5);
      arriba(oscuro, `--${e}-tint`, "--bg");
      piso(oscuro, `--${e}-soft`, `--${e}-tint`, 1.3);
    }
    piso(oscuro, "--danger-fg", "--danger", 4.5);
  });
});

describe("tema oscuro: acento", () => {
  const set = resolveAccentSet(DEFAULT_BRANDING.accent, "dark");

  it("el respaldo de globals.css es el que calcula lib/branding", () => {
    // Se alguém retocar a receita e não o respaldo (ou o contrário), a primeira
    // pintura sem white-label sai de outra cor que o resto.
    expect(hex(oscuro, "--accent")).toBe(set.accent);
    expect(hex(oscuro, "--accent-hover")).toBe(set.hover);
    expect(hex(oscuro, "--accent-soft")).toBe(set.soft);
    expect(hex(oscuro, "--accent-tint")).toBe(set.tint);
    expect(hex(oscuro, "--accent-text")).toBe(set.text);
    expect(hex(oscuro, "--accent-fg")).toBe(set.fg);
  });

  it("la fila seleccionada se ve sin leer el color del texto (tint ≥ 1.25:1)", () => {
    piso(oscuro, "--accent-tint", "--bg", 1.25);
    piso(oscuro, "--accent-soft", "--bg", 1.5);
  });

  it("el acento rellena (≥ 3:1) y su tinta se lee (≥ 4.5:1)", () => {
    piso(oscuro, "--accent", "--bg", 3);
    piso(oscuro, "--accent-fg", "--accent", 4.5);
    for (const s of ["--bg", "--bg-raised", "--accent-tint"]) {
      piso(oscuro, "--accent-ink", s, 4.5); // uma hora, um link, «IA»
    }
  });

  it("el anillo de foco se ve donde hay algo enfocable (≥ 3:1)", () => {
    for (const s of ["--bg-subtle", "--bg", "--bg-raised", "--bg-panel", "--accent-tint"]) {
      piso(oscuro, "--ring", s, 3);
    }
  });
});

describe("tema claro: no cambia", () => {
  it("lo que flota, la tinta y el anillo del acento son los de siempre", () => {
    expect(claro["--bg-raised"]).toBe(claro["--bg"]);
    expect(claro["--accent-ink"]).toBe("var(--accent)");
    expect(claro["--ring"]).toBe("var(--accent)");
  });

  it("la barra (.nav-dark) conserva sus valores: se ve igual en los dos temas", () => {
    // São os que tinha quando copiava para o tema escuro de antes; se a barra
    // mudar, muda também no claro, que é o tema que o dono gosta.
    expect(nav).toMatchObject({
      "--bg": "#0b1327",
      "--bg-subtle": "#070e20",
      "--bg-panel": "#131f3d",
      "--bg-hover": "#182750",
      "--text": "#e8eefc",
      "--text-2": "#a9b8dc",
      "--text-3": "#7688b0",
      "--border": "#263866",
      "--border-strong": "#34498a",
      "--ring": "var(--accent)",
    });
    expect(css).toMatch(/\.nav-dark \{\s*color-scheme: dark;/);
  });

  it("dentro de la barra el texto se lee", () => {
    piso(nav, "--text", "--bg-subtle", 7);
    piso(nav, "--text-2", "--bg-hover", 4.5);
    piso(nav, "--text-3", "--bg-subtle", 4.5);
  });
});

describe("tinta sobre el acento: blanca solo si pasa AA (≥ 4.5:1)", () => {
  // Predefinições + cores que um negócio de fato escolhe: um verde (antes 3.3:1 com
  // branco), um amarelo, um vermelho, um roxo, um cinza e um azul profundo.
  const acentos = [
    ...Object.keys(ACCENT_PRESETS),
    "#16a34a",
    "#f59e0b",
    "#e11d48",
    "#7c3aed",
    "#6b7280",
    "#12305a",
    "#ffee88",
  ];

  it("en los dos temas y en la barra", () => {
    for (const a of acentos) {
      for (const [donde, s] of [
        ["claro", resolveAccentSet(a, "light")],
        ["oscuro", resolveAccentSet(a, "dark")],
        ["barra", resolveNavAccentSet(a)],
      ] as const) {
        const c = contraste(s.fg, s.accent);
        expect(c, `${a} en ${donde}: ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("un acento claro lleva tinta oscura en vez de oscurecerse más", () => {
    const verde = resolveAccentSet("#16a34a", "light");
    expect(verde.accent).toBe("#16a34a");
    expect(verde.fg).not.toBe("#ffffff");
  });

  it("en oscuro cada acento se despega de la página y su tinta se lee", () => {
    const pagina = hex(oscuro, "--bg");
    for (const a of acentos) {
      const s = resolveAccentSet(a, "dark");
      expect(contraste(s.accent, pagina), `${a}: relleno`).toBeGreaterThanOrEqual(3);
      expect(contraste(s.text, s.tint), `${a}: tinta sobre tint`).toBeGreaterThanOrEqual(4.5);
      expect(contraste(s.text, pagina), `${a}: tinta sobre la página`).toBeGreaterThanOrEqual(4.5);
      // O tom ajuda (um vermelho se distingue do azul-marinho mesmo que sua
      // luminância se aproxime); o azul Vocero leva seu próprio piso, 1.25.
      expect(contraste(s.tint, pagina), `${a}: tint`).toBeGreaterThanOrEqual(1.1);
    }
  });

  it("en la barra, el acento se calcula contra SU fondo (≥ 3.5:1)", () => {
    for (const a of acentos) {
      const s = resolveNavAccentSet(a);
      expect(contraste(s.accent, hex(nav, "--bg")), a).toBeGreaterThanOrEqual(3.5);
      expect(contraste(s.text, s.tint), `${a}: tinta sobre tint`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
