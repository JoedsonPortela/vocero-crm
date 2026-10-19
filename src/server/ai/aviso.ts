import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { estadoIaDe, mensajeDeEstado } from "@/lib/ai/provider";

/**
 * Precisa avisar o dono de que o agente dele não consegue responder?
 * (adaptação de `aviso-ia` do Vocero Cloud, issue #85)
 *
 * O caso que isto fecha: uma organização com o agente ligado e sem
 * provedor de IA (ou com a chave rejeitada). A mensagem entra, o turno não
 * tem com que pensar e a conversa fica na caixa de entrada. De fora
 * parece exatamente um bot quebrado — e o único lugar onde isso era
 * explicado era um quadro dentro do painel de UM contato.
 *
 * Exige-se que o agente esteja LIGADO: sem IA e com o agente desligado
 * não há nada a avisar. O que se aponta é a contradição.
 */
export type AvisoIa = { mensaje: string; accion: string } | null;

export async function avisoIaDe(organizationId: string): Promise<AvisoIa> {
  const estado = await estadoIaDe(organizationId);
  if (estado.activa) return null;

  const db = getDb();
  const filas = await db
    .select({ enabled: schema.agentProfile.enabled })
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  if (!filas[0]?.enabled) return null;

  const mensaje = mensajeDeEstado(estado);
  if (!mensaje) return null;

  return {
    mensaje,
    // Sem configurar, vai colar a chave; pausada, para revisar a conexão.
    // As duas terminam na mesma tela, e dizer isso evita o «e onde?».
    accion:
      estado.motivo === "sin_configurar"
        ? "Configurar la IA"
        : "Revisar mi conexión",
  };
}
