/**
 * Motivos pelos quais um cérebro externo devolve a conversa a um humano.
 *
 * O catálogo é fechado, mas aplica-se com FALLBACK, nunca rejeitando: um
 * motivo fora da lista não pode custar o handoff. Um 422 aqui deixaria o bot
 * falando com alguém que acabou de pedir uma pessoa — o pior final possível
 * dessa rota. Do outro lado há um LLM: mais cedo ou mais tarde ele manda "porque se
 * irritou" em vez de "hostilidade".
 */

export const HANDOFF_REASONS = [
  "cliente",
  "modelo",
  "error",
  "ventana",
  "hostilidad",
] as const;

export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export function toHandoffReason(raw: string | undefined | null): HandoffReason {
  const v = raw?.trim().toLowerCase() ?? "";
  return (HANDOFF_REASONS as readonly string[]).includes(v)
    ? (v as HandoffReason)
    : "modelo";
}
