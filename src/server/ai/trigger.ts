import { scheduleAgentTurn } from "@/server/ai/pipeline";
import { isAiConfiguredFor } from "@/lib/ai/provider";
import { despachoActivo } from "@/server/brains/config";
import { despacharAlCerebro } from "@/server/dispatch/encolar";

/**
 * Ponto de engate do turno após a ingestão de uma mensagem recebida REAL (as
 * conversas do Laboratório invocam o pipeline diretamente, sem
 * debounce).
 *
 * 021 — Com um cérebro configurado (`BRAIN_DISPATCH_URL` + `BOT_API_KEY`) o
 * turno não é pensado aqui: enfileira-se um despacho e o worker o entrega. Os
 * dois caminhos são excludentes: enquanto o despacho está ativo o agente
 * incluído não responde, tenha ou não provedor de IA e interruptor ligado. É
 * o que evita a dupla resposta sem depender de que alguém se lembre de
 * desligar um dos dois.
 *
 * 025 — `messageId` é a mensagem recebida que provoca o turno. Quem a leve (o
 * despacho na sua linha, o agente incluído no seu coalesce) a anota como algo
 * que DEVE ser atendido: se o cliente escrever enquanto se pensa a resposta à
 * anterior, essa mensagem fica atrás dela e, sem a nota, é dada como atendida.
 */
export async function maybeRunAgentTurn(
  conversationId: string,
  organizationId: string,
  messageId: string
): Promise<void> {
  if (despachoActivo()) {
    await despacharAlCerebro(conversationId, organizationId, messageId);
    return;
  }
  if (!(await isAiConfiguredFor(organizationId))) return;
  scheduleAgentTurn(conversationId, messageId);
}
