import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Escopo de tenant obrigatório (Constituição III).
 *
 * Toda query de domínio é construída com `scoped(...)`: exige o
 * organization_id explícito e o combina com o restante das condições,
 * de modo que um WHERE sem tenant não compile de forma natural.
 */
export function scoped(
  organizationColumn: PgColumn,
  organizationId: string,
  ...conditions: (SQL | undefined)[]
): SQL {
  if (!organizationId) {
    throw new Error("scoped(): organizationId vacío — query sin tenant");
  }
  const base = eq(organizationColumn, organizationId);
  const rest = conditions.filter((c): c is SQL => c !== undefined);
  return rest.length > 0 ? and(base, ...rest)! : base;
}
