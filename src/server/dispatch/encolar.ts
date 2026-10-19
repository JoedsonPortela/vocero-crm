import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { encolarDespacho } from "@/server/dispatch/outbox";
import { iniciarWorker, programarTanda } from "@/server/dispatch/worker";

/**
 * 021 — O gancho da ingestão: uma mensagem recebida real já está na
 * caixa de entrada e há um cérebro configurado, então seu turno é ENFILEIRADO em vez de
 * pensado aqui.
 *
 * Nunca lança. Roda no fim da ingestão, dentro do `after()` do webhook:
 * uma exceção aqui não pode custar a esse payload as mensagens que vierem
 * depois. O que não foi enfileirado segue na caixa de entrada.
 */
export async function despacharAlCerebro(
  conversationId: string,
  organizationId: string,
  messageId: string
): Promise<void> {
  try {
    const [conv] = await getDb()
      .select({
        aiEnabled: schema.conversation.aiEnabled,
        handoffAt: schema.conversation.handoffAt,
        isTest: schema.conversation.isTest,
      })
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.id, conversationId),
          eq(schema.conversation.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!conv) return;

    // Pausada por uma pessoa ou transferida pelo agente: não se despacha. É
    // a mesma bandeira que respeita `/api/bot/messages`, e aqui a respeita
    // qualquer cérebro sem precisar lembrar. O Laboratório não passa pela
    // ingestão, mas uma conversa de teste não sai do CRM por nenhum
    // caminho.
    if (!conv.aiEnabled || conv.handoffAt || conv.isTest) return;

    // 025 — O despacho anota qual mensagem recebida o provoca: é o que ele deve
    // ao cérebro, mesmo que depois a conversa tenha uma resposta.
    const { notBefore } = await encolarDespacho({
      organizationId,
      conversationId,
      messageIds: [messageId],
    });
    iniciarWorker();
    // Que desperte justo quando a janela vencer, não no seu próximo varrimento.
    programarTanda(notBefore);
  } catch (err) {
    console.error("[despacho] no se pudo encolar el turno:", err);
  }
}
