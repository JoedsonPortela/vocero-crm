import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "@/components/ui/switch";

/**
 * El interruptor compartido (#53).
 *
 * O do Agente e o de «IA nesta conversa» eram duas cópias à mão e
 * divergiram duas vezes: primeiro o botão perdeu sua sombra; depois o do
 * Agente ficou `absolute` sem `left`, começava no CENTRO da pista e
 * quando ligado saía para fora. Aqui se fixa a geometria —com as classes do Tailwind,
 * uma unidade são 4 px— e que não volte a aparecer outra cópia.
 *
 * Se você está lendo isto porque ficou vermelho: não copie o interruptor,
 * estenda `components/ui/switch.tsx`.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const UNICO = path.join(SRC, "components", "ui", "switch.tsx");

function archivos(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...archivos(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

type Props = Parameters<typeof Switch>[0];

function dibujar(props: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    createElement(Switch, {
      checked: false,
      onCheckedChange: () => {},
      label: "Prueba",
      ...props,
    })
  );
}

/** Classes da pista (o `<button>`) e da bolinha (seu `<span>`). */
function clases(html: string): { pista: string[]; pomo: string[] } {
  const de = (re: RegExp) => re.exec(html)?.[1]?.split(/\s+/) ?? [];
  return {
    pista: de(/<button[^>]*class="([^"]*)"/),
    pomo: de(/<span[^>]*class="([^"]*)"/),
  };
}

/** `w-11` → 44 px, `px-0.5` → 2 px, `translate-x-5` → 20 px; sem a classe, 0. */
function px(lista: string[], prefijo: string): number {
  const c = lista.find((x) => x.startsWith(prefijo));
  return c ? Number(c.slice(prefijo.length)) * 4 : 0;
}

describe("interruptor: el pomo no se sale de la pista (#53)", () => {
  for (const size of ["md", "sm"] as const) {
    it(`${size}: apagado pegado al borde izquierdo, encendido al derecho`, () => {
      const apagado = clases(dibujar({ size, checked: false }));
      const encendido = clases(dibujar({ size, checked: true }));

      // A bolinha se acomoda com flex a partir da borda interna esquerda. Uma
      // `absolute` dentro de um <button> sem `left` começa do centro: é
      // exatamente o bug que foi relatado.
      expect(apagado.pista).toEqual(expect.arrayContaining(["inline-flex", "items-center"]));
      expect(apagado.pomo).not.toContain("absolute");

      const pista = px(apagado.pista, "w-");
      const margen = px(apagado.pista, "px-");
      const pomo = px(apagado.pomo, "w-");
      expect(pista).toBeGreaterThan(0);
      expect(margen).toBeGreaterThan(0);

      // Desligado: sem deslocamento, a bolinha fica a `margem` da borda.
      expect(px(apagado.pomo, "translate-x-")).toBe(0);
      // Ligado: desloca-se exatamente o que sobra à pista e fica a
      // `margem` da borda direita. Nem um pixel para fora.
      expect(margen + pomo + px(encendido.pomo, "translate-x-") + margen).toBe(pista);

      // Y cabe a lo alto.
      expect(px(apagado.pomo, "h-")).toBeLessThan(px(apagado.pista, "h-"));
    });
  }
});

describe("interruptor: accesible", () => {
  it("es un switch con nombre y estado, y no envía formularios", () => {
    const html = dibujar({ checked: true, label: "Agente encendido" });
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Agente encendido"');
    expect(html).toContain('type="button"');
    expect(dibujar({ checked: false })).toContain('aria-checked="false"');
  });

  it("deshabilitado se ve atenuado y no se puede operar", () => {
    const { pista } = clases(dibujar({ disabled: true }));
    expect(dibujar({ disabled: true })).toMatch(/<button[^>]*disabled=""/);
    expect(pista).toContain("disabled:opacity-40");
  });

  it("tiene anillo de foco visible para quien usa el teclado", () => {
    // O acento sólido, que por construção contrasta ≥ 3:1 com o fundo nos
    // dois temas (ver resolveAccentSet), separado da pista: ligada
    // já é da cor do acento. O suave (`ring-brand-soft`) não chega.
    const { pista } = clases(dibujar({ checked: true }));
    expect(pista).toEqual(
      expect.arrayContaining([
        "focus-visible:ring-2",
        "focus-visible:ring-ring",
        "focus-visible:ring-offset-2",
      ])
    );
    expect(pista).not.toContain("focus-visible:ring-brand-soft");
  });
});

describe("interruptor: uno solo en todo el producto", () => {
  it("nadie más dibuja un `role=\"switch\"` a mano", () => {
    const copias = archivos(SRC).filter(
      (f) =>
        path.resolve(f) !== path.resolve(UNICO) &&
        readFileSync(f, "utf8").includes('role="switch"')
    );
    expect(copias.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("el Agente y la IA de la conversación usan el compartido", () => {
    for (const rel of ["components/agent/agent-client.tsx", "components/inbox/contact-panel.tsx"]) {
      const code = readFileSync(path.join(SRC, rel), "utf8");
      expect(code, rel).toContain('from "@/components/ui/switch"');
      expect(code, rel).toMatch(/<Switch\b/);
    }
  });
});
