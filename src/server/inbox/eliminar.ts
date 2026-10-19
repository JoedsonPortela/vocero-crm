import { and, eq, gt, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { vaciarFicha } from "@/server/bot/ficha";
import type { CanalDelEvento } from "@/server/brains/contract";
import { deleteMediaFile } from "@/server/whatsapp/media";

/**
 * 026 — Eliminar uma conversa, por pedido explícito de quem administra
 * o negócio.
 *
 * Dois alcances, porque são duas intenções diferentes:
 *
 * - `fio`: vão-se as mensagens, seus anexos e a ficha. O contato, seu
 *   lugar no pipeline e seus agendamentos passados ficam. Se a pessoa voltar a
 *   escrever, é uma conversa nova.
 * - `contato`: vai-se a pessoa inteira. Tudo o que depende dela cai em
 *   cascata, incluindo seu histórico de etapas — os números de Resultados
 *   mudam, e por isso é uma caixa à parte e não o comportamento normal.
 *
 * Quase todo o trabalho é feito pelas chaves estrangeiras com ON DELETE CASCADE. O que
 * este módulo acrescenta é o que uma cascata não consegue fazer: os anexos (linha e
 * arquivo), a ficha e o agendamento futuro que detém a exclusão.
 */

export type AlcanceBorrado = "hilo" | "contacto";

export type ConversacionEliminada = {
  id: string;
  channel: CanalDelEvento;
};

export type ResultadoEliminar =
  | {
      ok: true;
      alcance: AlcanceBorrado;
      organization: { id: string; slug: string | null };
      contact: { id: string; identity: string };
      /** Em `fio`, um. Em `contato`, todas as reais dessa pessoa. */
      conversaciones: ConversacionEliminada[];
    }
  | { ok: false; motivo: "no_encontrada" }
  | { ok: false; motivo: "cita_pendiente"; cuando: Date };

export async function eliminarConversacion(
  organizationId: string,
  conversationId: string,
  alcance: AlcanceBorrado
): Promise<ResultadoEliminar> {
  const db = getDb();
  const archivos: string[] = [];

  const resultado = await db.transaction(async (tx): Promise<ResultadoEliminar> => {
    const [org] = await tx
      .select({ id: schema.organization.id, slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1);
    if (!org) return { ok: false, motivo: "no_encontrada" };

    const [fila] = await tx
      .select({
        conversation: schema.conversation,
        contact: schema.contact,
      })
      .from(schema.conversation)
      .innerJoin(
        schema.contact,
        and(
          eq(schema.contact.organizationId, schema.conversation.organizationId),
          eq(schema.contact.id, schema.conversation.contactId)
        )
      )
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, conversationId)
        )
      )
      // Duas pessoas apagando ao mesmo tempo: a segunda espera e depois não a
      // encontra, em vez de apagar pela metade.
      .for("update")
      .limit(1);
    // Uma conversa do Laboratório não vive na caixa de entrada: por aqui não
    // existe. Suas execuções são limpas pelo Laboratório.
    if (!fila || fila.conversation.isTest) return { ok: false, motivo: "no_encontrada" };
    const { contact } = fila;
    const todoElContacto = alcance === "contacto";

    const conversaciones = todoElContacto
      ? await tx
          .select()
          .from(schema.conversation)
          .where(
            scoped(
              schema.conversation.organizationId,
              organizationId,
              eq(schema.conversation.contactId, contact.id)
            )
          )
      : [fila.conversation];
    const ids = conversaciones.map((c) => c.id);

    /**
     * Um agendamento futuro detém a exclusão, nos dois alcances.
     *
     * O agendamento sobrevive ao fio (`conversation_id` fica em NULL), mas seu
     * lembrete é enviado PELA conversa: sem ela não sairia, e ninguém
     * ficaria sabendo. E apagar o contato levaria o agendamento do banco
     * deixando viva a reunião no Google ou no Zoom. Cancelar é o caminho que
     * avisa quem precisa ser avisado.
     */
    const [cita] = await tx
      .select({ cuando: schema.booking.scheduledAt })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.status, "agendada"),
          eq(schema.booking.isTest, false),
          gt(schema.booking.scheduledAt, new Date()),
          todoElContacto
            ? eq(schema.booking.contactId, contact.id)
            : eq(schema.booking.conversationId, conversationId)
        )
      )
      .orderBy(schema.booking.scheduledAt)
      .limit(1);
    if (cita) return { ok: false, motivo: "cita_pendiente", cuando: cita.cuando };

    // Os anexos são anotados ANTES de apagar: depois já não há mensagem que
    // diga quais eram.
    const deMensajes = await tx
      .selectDistinct({ id: schema.message.mediaAssetId })
      .from(schema.message)
      .where(
        scoped(
          schema.message.organizationId,
          organizationId,
          inArray(schema.message.conversationId, ids),
          isNotNull(schema.message.mediaAssetId)
        )
      );
    const deAnuncios = await tx
      .select({ id: schema.adAttribution.imageAssetId })
      .from(schema.adAttribution)
      .where(
        scoped(
          schema.adAttribution.organizationId,
          organizationId,
          inArray(schema.adAttribution.conversationId, ids),
          isNotNull(schema.adAttribution.imageAssetId)
        )
      );
    const candidatos = [
      ...new Set(
        [...deMensajes, ...deAnuncios]
          .map((r) => r.id)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    if (todoElContacto) {
      await tx
        .delete(schema.contact)
        .where(
          scoped(
            schema.contact.organizationId,
            organizationId,
            eq(schema.contact.id, contact.id)
          )
        );
    } else {
      await tx
        .delete(schema.conversation)
        .where(
          scoped(
            schema.conversation.organizationId,
            organizationId,
            eq(schema.conversation.id, conversationId)
          )
        );
      // A ficha é o que o agente foi aprendendo desta pessoa, e viaja
      // ao cérebro em cada turno: deixá-la seria apagar o fio e conservar
      // justamente o que o agente lembrava dele.
      await vaciarFicha(tx, organizationId, contact.id);
    }

    if (candidatos.length > 0) {
      // Só os anexos que ninguém mais usa: a imagem de um anúncio pode
      // estar em outra conversa.
      const borrados = await tx
        .delete(schema.mediaAsset)
        .where(
          and(
            eq(schema.mediaAsset.organizationId, organizationId),
            inArray(schema.mediaAsset.id, candidatos),
            notExists(
              tx
                .select({ uno: sql`1` })
                .from(schema.message)
                .where(eq(schema.message.mediaAssetId, schema.mediaAsset.id))
            ),
            notExists(
              tx
                .select({ uno: sql`1` })
                .from(schema.adAttribution)
                .where(eq(schema.adAttribution.imageAssetId, schema.mediaAsset.id))
            )
          )
        )
        .returning({ id: schema.mediaAsset.id });
      archivos.push(...borrados.map((a) => a.id));
    }

    return {
      ok: true,
      alcance,
      organization: org,
      contact: { id: contact.id, identity: contact.waIdentity },
      // Ao cérebro só se avisa das reais: de uma de teste ele nunca soube.
      conversaciones: conversaciones
        .filter((c) => !c.isTest)
        .map((c) => ({ id: c.id, channel: c.channel })),
    };
  });

  // Os arquivos, DEPOIS do commit: se a transação for revertida, as
  // linhas voltam e seus arquivos têm que continuar ali. Ao contrário, só fica
  // um arquivo órfão que ninguém consegue abrir, e não uma mensagem sem anexo.
  if (resultado.ok && archivos.length > 0) {
    const intentos = await Promise.allSettled(
      archivos.map((id) => deleteMediaFile(organizationId, id))
    );
    const fallidos = intentos.filter((r) => r.status === "rejected").length;
    if (fallidos > 0) {
      console.warn(
        `[bandeja] ${fallidos} de ${archivos.length} adjuntos no se pudieron borrar del volumen (${organizationId})`
      );
    }
  }

  return resultado;
}
