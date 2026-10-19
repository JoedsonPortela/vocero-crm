import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { Channel } from "@/lib/channels";
import { capabilitiesFor } from "@/server/channels/capabilities";

/**
 * 022 — O teto de mensagens de um canal.
 *
 * O TikTok aceita até 10 mensagens depois da última mensagem do cliente, e
 * a décima primeira falha com um erro da plataforma que não diz muita coisa. Conta-se
 * aqui, antes de chamar ninguém, para rejeitá-la com um motivo que o
 * operador entenda e um código que um cérebro possa tratar.
 *
 * Não é um limite de velocidade: não se recupera esperando, só quando o
 * cliente volta a escrever.
 */

/** Pura: cabe mais uma mensagem? Um canal sem teto sempre diz que sim. */
export function cabeOtroMensaje(channel: Channel, enviados: number): boolean {
  const tope = capabilitiesFor(channel).maxOutboundPerWindow;
  return tope === null || enviados < tope;
}

/**
 * Quantas mensagens saíram na conversa desde a última mensagem recebida.
 *
 * Conta o que saiu de fato —de uma pessoa ou do agente—; um envio
 * falho não gastou nada na plataforma. A comparação de horas é feita no
 * Postgres, que guarda microssegundos.
 */
export async function salientesDesdeElUltimoEntrante(
  organizationId: string,
  conversationId: string
): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n
    from message m
    where m.organization_id = ${organizationId}
      and m.conversation_id = ${conversationId}
      and m.direction = 'out'
      and m.status <> 'failed'
      and m.created_at > coalesce((
        select max(e.created_at) from message e
        where e.organization_id = ${organizationId}
          and e.conversation_id = ${conversationId}
          and e.direction = 'in'
      ), '-infinity'::timestamp)
  `);
  return Number(rows[0]?.n ?? 0);
}
