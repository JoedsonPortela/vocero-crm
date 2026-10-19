import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Vigilância: um `ON CONFLICT` sobre `contact` tem que nomear EXATAMENTE
 * as colunas do índice único.
 *
 * Existe por uma falha real: a feature 014 mudou o índice de
 * `(organization_id, wa_identity)` para `(organization_id, channel, wa_identity)`
 * e deixou dois `onConflictDoNothing` apontando para o índice antigo. O Postgres não falha
 * ao compilar nem ao iniciar: falha na requisição, com
 * "no unique or exclusion constraint matching the ON CONFLICT specification".
 *
 * O resultado foi que o Laboratório e o cadastro manual de contatos ficaram
 * quebrados em `main` sem que nenhum teste percebesse — porque nenhum os
 * exercitava contra um banco real. Este teste é mais barato que voltar a
 * descobrir isso em produção.
 */

const CONTACT_INDEX_COLUMNS = ["organizationId", "channel", "waIdentity"];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("ON CONFLICT sobre contact", () => {
  it("nombra las tres columnas del índice único, en todos los sitios", () => {
    const offenders: string[] = [];

    for (const file of tsFilesUnder(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("schema.contact.waIdentity")) continue;

      // Só interessam os `target: [...]` de um onConflict.
      const targets = source.matchAll(/target:\s*\[([^\]]*)\]/g);
      for (const match of targets) {
        const body = match[1] ?? "";
        if (!body.includes("schema.contact.waIdentity")) continue;
        const faltantes = CONTACT_INDEX_COLUMNS.filter(
          (col) => !body.includes(`schema.contact.${col}`)
        );
        if (faltantes.length > 0) {
          offenders.push(
            `${file.replace(process.cwd(), "")} — le falta: ${faltantes.join(", ")}`
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
