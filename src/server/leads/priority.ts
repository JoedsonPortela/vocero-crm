import type { PriorityValue } from "@/lib/types";

/**
 * Prioridade de fechamento do lead.
 *
 * Quem a define é o dono, e NADA a escreve automaticamente. Um CRM que adivinha a
 * prioridade e a sobrescreve quando muda de ideia é um CRM em que se deixa de
 * confiar: NULL significa "ninguém a decidiu", não "média".
 *
 * Sem sugestões de propósito. Deduzi-la exigiria sinais que este CRM não tem
 * (está qualificado? respondeu?), e uma sugestão calculada com dois dados
 * pobres erra o bastante para que o dono deixe de olhá-la.
 */

export const PRIORITY_VALUES: readonly PriorityValue[] = ["alta", "media", "baja"];

export const PRIORITY_LABELS: Record<PriorityValue, string> = {
  alta: "Alta",
  media: "Media",
  baja: "Baja",
};

export function isPriority(v: unknown): v is PriorityValue {
  return typeof v === "string" && (PRIORITY_VALUES as readonly string[]).includes(v);
}

/** Ordem de trabalho: alta primeiro, e o que não tem prioridade vai para o fim. */
export const PRIORITY_RANK: Record<PriorityValue, number> = {
  alta: 0,
  media: 1,
  baja: 2,
};

export function priorityRank(value: PriorityValue | null): number {
  return value ? PRIORITY_RANK[value] : 3;
}

/**
 * Ordena por prioridade e, em caso de empate, mantém a ordem que trazia. Os leads sem
 * prioridade ficam no fim: não são urgentes, mas também não se escondem.
 */
export function byPriority<T extends { priority: PriorityValue | null }>(
  leads: readonly T[]
): T[] {
  return [...leads].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}
