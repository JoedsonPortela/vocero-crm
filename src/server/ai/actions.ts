import { z } from "zod";

/**
 * Ação tipada do agente: exatamente UMA por turno (FR-021).
 * O servidor valida cada ação contra suas allowlists (etapas da organização);
 * o que não valida é degradado, nunca executado às cegas.
 */
const baseActions = [
  z.object({ action: z.literal("none") }),
  z.object({ action: z.literal("reply"), text: z.string().min(1) }),
  z.object({
    action: z.literal("update_lead"),
    note: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("move_stage"),
    stage: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("handoff"),
    reason: z.string().optional(),
    farewell: z.string().optional(),
  }),
] as const;

/**
 * 015 — As duas ações de agenda. Só são registradas se esta instância tiver
 * a flag ligada: onde não há agenda, o modelo nem sequer consegue
 * citá-las.
 *
 * `reply` é uma introdução opcional, NÃO a lista de horários: os horários
 * são colados pelo motor com as etiquetas reais. E `startUtc` precisa ser
 * exatamente um dos que o sistema ofereceu — senão o motor rejeita e
 * re-oferece.
 */
const agendaActions = [
  z.object({
    action: z.literal("offer_slots"),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("book_slot"),
    startUtc: z.string().min(1),
    reply: z.string().optional(),
  }),
] as const;

export const AgentAction = z.discriminatedUnion("action", [
  ...baseActions,
  ...agendaActions,
]);

/** O esquema exigido do modelo NESTE turno. */
export function agentActionSchema(agenda: boolean) {
  return agenda
    ? AgentAction
    : z.discriminatedUnion("action", [...baseActions]);
}

export type AgentActionType = z.infer<typeof AgentAction>;

/**
 * Resolve o nome da etapa devolvido pelo modelo contra as etapas reais
 * da organização (exato → minúsculas). Sem correspondência: rebaixar para reply/none.
 */
export function resolveStage(
  requested: string,
  stages: { id: string; name: string }[]
): { id: string; name: string } | null {
  const exact = stages.find((s) => s.name === requested.trim());
  if (exact) return exact;
  const lower = requested.trim().toLowerCase();
  return stages.find((s) => s.name.toLowerCase() === lower) ?? null;
}

/** Rebaixa uma ação que não pôde ser executada (FR-021 / contrato ai.md). */
export function degradeAction(action: AgentActionType): AgentActionType {
  if (
    action.action === "move_stage" ||
    action.action === "offer_slots" ||
    action.action === "book_slot"
  ) {
    return action.reply
      ? { action: "reply", text: action.reply }
      : { action: "none" };
  }
  return action;
}
