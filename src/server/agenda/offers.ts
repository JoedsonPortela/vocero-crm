import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 015 — Memória do que foi ofertado a uma conversa (requisito INEGOCIÁVEL).
 *
 * Sem linha aqui não há reserva: é o que impede um modelo de inventar um
 * horário que nunca foi oferecido ao cliente. A oferta é substituída inteira
 * a cada rodada (a vigente é sempre a última) e é limpa ao reservar.
 */

export type OfferedSlot = { startUtc: string; label: string };

/** Substitui TODA a oferta da conversa, numa transação. */
export async function replaceOffers(
  organizationId: string,
  conversationId: string,
  slots: OfferedSlot[]
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.offeredSlot)
      .where(
        scoped(
          schema.offeredSlot.organizationId,
          organizationId,
          eq(schema.offeredSlot.conversationId, conversationId)
        )
      );
    if (slots.length === 0) return;
    await tx.insert(schema.offeredSlot).values(
      slots.map((s) => ({
        id: newId("offeredSlot"),
        organizationId,
        conversationId,
        startUtc: new Date(s.startUtc),
        label: s.label,
      }))
    );
  });
}

export async function getOffers(
  organizationId: string,
  conversationId: string
): Promise<OfferedSlot[]> {
  const db = getDb();
  const rows = await db
    .select({
      startUtc: schema.offeredSlot.startUtc,
      label: schema.offeredSlot.label,
    })
    .from(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        eq(schema.offeredSlot.conversationId, conversationId)
      )
    )
    .orderBy(asc(schema.offeredSlot.startUtc));

  return rows.map((r) => ({
    startUtc: r.startUtc.toISOString(),
    label: r.label,
  }));
}

export async function clearOffers(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        eq(schema.offeredSlot.conversationId, conversationId)
      )
    );
}

/**
 * O instante pedido está entre os ofertados? Comparação por **epoch
 * exato**: nada de tolerâncias nem de comparar texto. Um ISO com outro offset
 * mas o mesmo instante VALE; um minuto de diferença NÃO.
 *
 * A tolerância seria a porta por onde entra a alucinação: um modelo
 * inventa "terça às 10" com facilidade, e comparar exato transforma isso
 * em uma recusa com a lista do que de fato foi ofertado.
 */
export function findOffered(
  offers: OfferedSlot[],
  whenISO: string
): OfferedSlot | null {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;
  return offers.find((o) => Date.parse(o.startUtc) === target) ?? null;
}

/** Igualdade de instante, exposta para os testes. */
export function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && x === y;
}

/**
 * Cabeçalho do bloco de horários que o modelo vê.
 *
 * É uma constante e não uma string solta porque há DOIS lados que dependem
 * dela: quem a escreve (o turno do agente) e quem a lê (o mock de IA
 * do self-test). Com duas cópias, no dia em que a frase mudar o roteiro passaria
 * a verde sem exercitar nada.
 */
export const CABECERA_HUECOS =
  "Horarios vigentes de esta conversación. Para book_slot usa el startUtc " +
  "EXACTO de la columna derecha, copiado tal cual:";

/**
 * Os horários vigentes, na forma em que o modelo pode usá-los.
 *
 * `book_slot` exige o `startUtc` e `findOffered` compara por epoch, sem
 * tolerância. Mas ao modelo só chegam o prompt e o histórico de TEXTO,
 * onde estão os rótulos que o cliente leu — «seg 7 set, 11:00» — sem ano,
 * sem fuso e sem a data de hoje. Com isso, acertar o instante era questão de
 * sorte: a recusa caía sempre em `slot_not_offered`, cujo texto é fixo, e
 * a conversa ficava em loop repetindo a lista.
 *
 * Devolve `null` sem oferta vigente, para que o modelo continue obrigado a
 * ofertar antes de reservar.
 *
 * Reportado por @Diony7004 em #50, com o diagnóstico já feito.
 */
export function mapaDeHuecosParaModelo(ofertas: OfferedSlot[]): string | null {
  if (ofertas.length === 0) return null;
  return [
    CABECERA_HUECOS,
    ...ofertas.map((o) => `- "${o.label}" → ${o.startUtc}`),
  ].join("\n");
}
