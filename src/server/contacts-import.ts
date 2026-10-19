import { and, eq, inArray, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { ImportRow } from "@/lib/contact-import";

/** O Postgres aceita ~65 mil parâmetros por consulta; com folga de sobra. */
const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

export type ImportResult = {
  /** Contatos novos. */
  created: number;
  /** Já existiam: não se duplicam nem se muda o nome deles. */
  existing: number;
  /** Para quantos se desligou o agente (novos + existentes). */
  paused: number;
};

/**
 * 027 — Importa contatos do WhatsApp em lote. Re-executável: importar duas vezes o
 * mesmo arquivo não duplica ninguém.
 *
 * - NÃO cria conversa: um fio vazio sujaria a Caixa de entrada. A pausa do
 *   agente fica guardada no contato e a conversa a herda ao nascer.
 * - NÃO cria lead: uma lista importada (clientes, membros) não é um funil, e
 *   levá-la ao Pipeline o encheria de gente que não é prospecto.
 * - Quem já existia tem o nome respeitado: o dono pode tê-lo editado.
 * - O nome do arquivo foi escrito por uma pessoa: fica como `manual`, e o
 *   nome de perfil do WhatsApp não o sobrescreve quando o importado escrever. Uma
 *   linha sem nome entra com o telefone como nome e `perfil`, para que
 *   o do WhatsApp o substitua assim que existir.
 */
export async function importContacts(
  organizationId: string,
  rows: ImportRow[],
  opts: { aiPaused: boolean }
): Promise<ImportResult> {
  const db = getDb();
  let created = 0;
  let existing = 0;
  let paused = 0;

  for (const batch of chunks(rows)) {
    const phones = batch.map((r) => r.phone);

    // Mesmo critério da ingestão: alguém pode existir por identidade ou por
    // telefone (um contato que chegou por BSUID e depois adquiriu seu número).
    const found = await db
      .select({
        id: schema.contact.id,
        waIdentity: schema.contact.waIdentity,
        phone: schema.contact.phone,
      })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.channel, "whatsapp"),
          or(
            inArray(schema.contact.waIdentity, phones),
            inArray(schema.contact.phone, phones)
          )
        )
      );
    const known = new Set<string>();
    for (const c of found) {
      known.add(c.waIdentity);
      if (c.phone) known.add(c.phone);
    }
    const existingIds = found.map((c) => c.id);
    existing += batch.filter((r) => known.has(r.phone)).length;

    const fresh = batch.filter((r) => !known.has(r.phone));
    let insertedIds: string[] = [];
    if (fresh.length > 0) {
      const inserted = await db
        .insert(schema.contact)
        .values(
          fresh.map((r) => ({
            id: newId("contact"),
            organizationId,
            name: r.name,
            nameSource: r.name === r.phone ? ("perfil" as const) : ("manual" as const),
            phone: r.phone,
            waIdentity: r.phone,
            aiPaused: opts.aiPaused,
          }))
        )
        .onConflictDoNothing({
          target: [
            schema.contact.organizationId,
            schema.contact.channel,
            schema.contact.waIdentity,
          ],
        })
        .returning({ id: schema.contact.id });
      insertedIds = inserted.map((c) => c.id);
      created += insertedIds.length;
      // Corrida com a ingestão: alguém escreveu entre o SELECT e o INSERT.
      existing += fresh.length - insertedIds.length;
    }

    if (!opts.aiPaused) continue;
    paused += insertedIds.length;

    if (existingIds.length > 0) {
      await db
        .update(schema.contact)
        .set({ aiPaused: true, updatedAt: new Date() })
        .where(
          scoped(
            schema.contact.organizationId,
            organizationId,
            inArray(schema.contact.id, existingIds)
          )
        );
      paused += existingIds.length;
      await pauseConversations(organizationId, existingIds, true);
    }
  }

  return { created, existing, paused };
}

/**
 * Leva a pausa do contato para a sua conversa real, se ela já existir.
 *
 * Sem isto, desligar o agente de alguém com quem já se está conversando não
 * teria efeito até que sua conversa fosse apagada e nascesse outra.
 * Retomar NÃO mexe em `handoff_at`: uma escalada que o agente decidiu se levanta
 * pela Caixa de entrada, onde se vê por que aconteceu.
 */
export async function pauseConversations(
  organizationId: string,
  contactIds: string[],
  paused: boolean
): Promise<void> {
  if (contactIds.length === 0) return;
  await getDb()
    .update(schema.conversation)
    .set({ aiEnabled: !paused, updatedAt: new Date() })
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        inArray(schema.conversation.contactId, contactIds),
        eq(schema.conversation.isTest, false)
      )
    );
}
