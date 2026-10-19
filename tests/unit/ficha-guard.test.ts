import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardrail da ficha do lead.
 *
 * A ficha é informação de qualificação dos clientes de alguém: qual
 * orçamento tem, o que o incomoda, se decide sozinho. É escrita por dois lados
 * —o cérebro externo por `PUT /api/bot/ficha` e o dono pela bandeja— e
 * as duas rotas entram por `upsertFicha`.
 *
 * Aqui se verifica que essa porta filtre por organização POR SI MESMA, e não
 * confiando que quem chama se lembre disso. Esse "lembre-se de filtrar" é
 * exatamente como se vazam dados entre inquilinos: nada explode, e o
 * incidente é descoberto quando já saiu.
 *
 * Se você está lendo isto porque o teste ficou vermelho: não o relaxe.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const PUERTA = path.join(SRC, "server", "bot", "ficha.ts");

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...archivosTs(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("guardarraíl: la ficha nunca se escribe sin organización", () => {
  const puerta = readFileSync(PUERTA, "utf8");

  it("`upsertFicha` recibe la organización", () => {
    const firma = puerta.slice(puerta.indexOf("export async function upsertFicha"));
    expect(firma.slice(0, 200)).toContain("organizationId");
  });

  it("y la usa: sus queries pasan por `scoped`, no por un `eq` pelón", () => {
    const cuerpo = puerta.slice(
      puerta.indexOf("export async function upsertFicha")
    );
    expect(cuerpo).toContain("scoped(");
    expect(cuerpo).toContain("schema.contact.organizationId");
  });

  it("nadie más escribe `contact.ficha` por su cuenta", () => {
    const culpables: string[] = [];
    for (const file of archivosTs(SRC)) {
      if (path.resolve(file) === path.resolve(PUERTA)) continue;
      const code = readFileSync(file, "utf8");
      // `.set({ … ficha … })` sobre a tabela de contatos, fora da porta.
      const re = /\.update\(\s*schema\.contact\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const bloque = code.slice(m.index, m.index + 400);
        if (/\bficha\b/.test(bloque)) {
          culpables.push(path.relative(SRC, file));
        }
      }
    }
    expect(culpables).toEqual([]);
  });
});
