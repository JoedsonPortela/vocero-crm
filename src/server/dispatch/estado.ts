import { and, count, desc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { BrainDispatchDto } from "@/lib/brain-status";
import { leerConfigDespacho, type ConfigDespacho } from "@/server/brains/config";

/**
 * 021 — O que «Quem responde» mostra do despacho: para quem se empurra,
 * quando chegou o último turno, qual foi o último que não chegou e quantos
 * esperam. Sai da tabela, não da memória do processo: sobrevive a um
 * reinício, diferente da «última chamada» de `/api/bot/*`.
 */

type Hechos = {
  lastDeliveredAt: Date | null;
  lastFailure: { at: Date; detail: string } | null;
  pending: number;
};

/** Pura: da configuração e dos fatos da tabela, ao DTO. */
export function dispatchDto(config: ConfigDespacho, hechos: Hechos): BrainDispatchDto {
  return {
    active: config.active,
    host: config.host,
    problem: config.active ? null : config.problem,
    lastDeliveredAt: hechos.lastDeliveredAt?.toISOString() ?? null,
    lastFailure: hechos.lastFailure
      ? { at: hechos.lastFailure.at.toISOString(), detail: hechos.lastFailure.detail }
      : null,
    pending: hechos.pending,
  };
}

const SIN_HECHOS: Hechos = { lastDeliveredAt: null, lastFailure: null, pending: 0 };

export async function estadoDelDespacho(
  organizationId: string
): Promise<BrainDispatchDto> {
  const config = leerConfigDespacho();
  // Sem variável não se pergunta nada ao banco: uma instância que não
  // despacha não paga três consultas cada vez que o cartão é pintado.
  if (!config.active && config.host === null && config.problem === null) {
    return dispatchDto(config, SIN_HECHOS);
  }

  const db = getDb();
  const deLaOrg = (cond: SQL | undefined) =>
    scoped(schema.dispatch.organizationId, organizationId, cond);
  const [[entregado], [fallo], [vivos]] = await Promise.all([
    db
      .select({ at: schema.dispatch.updatedAt })
      .from(schema.dispatch)
      .where(deLaOrg(eq(schema.dispatch.status, "entregado")))
      .orderBy(desc(schema.dispatch.updatedAt))
      .limit(1),
    // Uma falha que custou o turno (expirou) ou que continua sendo reintentada. Uma que
    // se recuperou não conta: `marcarEntregado` limpa o seu `last_error`.
    db
      .select({ at: schema.dispatch.updatedAt, detail: schema.dispatch.lastError })
      .from(schema.dispatch)
      .where(
        deLaOrg(
          and(
            isNotNull(schema.dispatch.lastError),
            inArray(schema.dispatch.status, ["caducado_a_humano", "pendiente", "en_vuelo"])
          )
        )
      )
      .orderBy(desc(schema.dispatch.updatedAt))
      .limit(1),
    db
      .select({ n: count() })
      .from(schema.dispatch)
      .where(deLaOrg(inArray(schema.dispatch.status, ["pendiente", "en_vuelo"]))),
  ]);

  return dispatchDto(config, {
    lastDeliveredAt: entregado?.at ?? null,
    lastFailure: fallo?.detail ? { at: fallo.at, detail: fallo.detail } : null,
    pending: vivos?.n ?? 0,
  });
}
