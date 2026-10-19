/**
 * Padrão de RESERVA de intenção de escalonamento (FR-022). Avalia-se sobre a
 * mensagem do cliente ANTES do LLM: se casar, a transferência acontece mesmo que o
 * modelo não a detecte. Projetado para exigir um verbo de contato perto do
 * objeto humano — "somos 4 pessoas" NÃO casa (teste unitário).
 */
export const HANDOFF_BACKUP_REGEX =
  /(hablar|comunicar|contactar)[\s\S]{0,40}?(asesor|humano|persona|alguien)|un asesor|atenci[oó]n humana/i;

export function matchesHandoffIntent(text: string): boolean {
  return HANDOFF_BACKUP_REGEX.test(text);
}

/**
 * O que o cliente ouve quando o padrão de reserva o transfere.
 *
 * O caminho do modelo se despede com seu `farewell`; este não mandava NADA, e
 * justamente pega os pedidos mais diretos («quero falar com um humano»).
 * A transferência acontecia por dentro, mas do lado do WhatsApp parecia que
 * o bot tinha deixado de responder a quem pediu uma pessoa.
 *
 * É fixo porque o perfil do agente não tem um campo para isso
 * (`escalationRules` diz QUANDO escalar, não o que dizer) e o turno corta
 * antes do modelo de propósito: não há de onde tirar outro texto. Não promete
 * um prazo nem um nome que o CRM não conhece.
 */
export const HANDOFF_BACKUP_ACK =
  "Claro, te comunico con una persona del equipo. En breve te responden.";
