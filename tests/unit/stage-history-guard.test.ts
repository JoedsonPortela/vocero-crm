import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardrail do histórico de etapas.
 *
 * Mover um lead e registrar a movimentação são a mesma operação. Se um caminho
 * novo escreve `lead.stage_id` por conta própria, nada explode: simplesmente o
 * histórico nasce com um buraco e os gráficos mentem meses depois, quando já
 * não há como reconstruí-lo.
 *
 * Este teste varre o código-fonte e falha se aparecer essa escrita fora de
 * a única porta. Se você está lendo isto porque o teste ficou vermelho: não o
 * relaxe — roteie sua mudança por `moveLeadToStage()`.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const PUERTA = path.join("server", "leads", "stage-history.ts");

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...archivosTs(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Trecho que segue a cada `.update(schema.lead)`, onde vive o `.set({…})`. */
function bloquesDeUpdate(code: string): string[] {
  const bloques: string[] = [];
  const re = /\.update\(\s*schema\.lead\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    bloques.push(code.slice(match.index, match.index + 400));
  }
  return bloques;
}

describe("guardarraíl: una sola puerta escribe la etapa del lead", () => {
  it("ningún archivo fuera de stage-history.ts actualiza lead.stageId", () => {
    const infractores: string[] = [];

    for (const file of archivosTs(SRC)) {
      if (file.endsWith(PUERTA)) continue;
      const code = readFileSync(file, "utf8");
      if (!code.includes("update(schema.lead)")) continue;

      for (const bloque of bloquesDeUpdate(code)) {
        if (/\bstageId\s*:/.test(bloque)) {
          infractores.push(path.relative(SRC, file));
          break;
        }
      }
    }

    expect(
      infractores,
      `Estos archivos cambian la etapa sin registrar el movimiento. ` +
        `Usa moveLeadToStage() de server/leads/stage-history.ts:\n` +
        infractores.map((f) => `  · ${f}`).join("\n")
    ).toEqual([]);
  });

  it("la puerta sí escribe la etapa (el test detectaría el patrón)", () => {
    // Se este teste falhar, a detecção acima deixou de servir: alguém
    // reescreveu a porta com outra forma e o guardrail ficou cego.
    const code = readFileSync(path.join(SRC, PUERTA), "utf8");
    const bloques = bloquesDeUpdate(code);
    expect(bloques.some((b) => /\bstageId\s*:/.test(b))).toBe(true);
  });
});
