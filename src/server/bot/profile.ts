import type { schema } from "@/lib/db";
import { renderKb } from "@/server/ai/prompts";

type AgentProfile = typeof schema.agentProfile.$inferSelect;
type KbEntry = typeof schema.kbEntry.$inferSelect;

/**
 * Payload do perfil do agente para um cérebro externo.
 *
 * `enabled` NÃO viaja: essa flag governa a IA in-process do Vocero; o bot
 * externo é pausado por conversa (`aiEnabled` do contexto e os handoffs),
 * não por este endpoint. `resources` nasce vazio para que o formato do consumidor
 * não mude quando existirem recursos alternativos reais.
 */
export function serializeBotProfile(profile: AgentProfile, kb: KbEntry[]) {
  return {
    profile: {
      name: profile.name,
      tone: profile.tone ?? null,
      instructions: profile.instructions ?? null,
      escalationRules: profile.escalationRules ?? null,
      greeting: profile.greeting ?? null,
    },
    kb: renderKb(kb),
    resources: [] as { label: string; url: string }[],
  };
}
