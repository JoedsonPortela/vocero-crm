import { and, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { publish } from "@/server/events/bus";

/**
 * 021 — A caixa de saída do despachante.
 *
 * Faz cumprir «caixa de entrada primeiro, cérebro depois»: a mensagem já está em
 * `message` antes de existir uma linha aqui. Se o despacho falhar, a
 * mensagem segue na caixa de entrada; se o processo morrer, o lease expira e o
 * próximo varrimento a retoma.
 *
 * O agrupamento de rajadas NÃO é implementado com temporizadores: quem faz isso é o
 * índice único parcial `dispatch_conversation_vivo_uq`, que permite no
 * máximo UM despacho vivo por conversa. Enfileirar cinco mensagens seguidas
 * faz um INSERT e quatro UPDATE da janela. A garantia é dada pelo Postgres,
 * então sobrevive a alguém reescrever o worker.
 *
 * Adaptação de `src/server/dispatch/outbox.ts` do Vocero Cloud.
 */

/**
 * Quanto se espera desde a última mensagem antes de despachar.
 *
 * É a MESMA variável usada pelo agente incluído (`AGENT_COALESCE_MS`), e de
 * propósito: a pergunta que ela responde é idêntica —quanto esperar até que
 * alguém termine de escrever sua rajada— e os dois caminhos nunca estão vivos ao
 * mesmo tempo. Dois nomes para um só conceito serviriam apenas para que alguém
 * baixasse um e se perguntasse por que nada acontece.
 */
export function ventanaCoalesceMs(): number {
  return getEnv().AGENT_COALESCE_MS;
}

/** Quanto tempo um worker reserva uma linha antes que outro possa pegá-la. */
export const LEASE_MS = 180_000;
export const MAX_INTENTOS = 3;
/** Espera após a tentativa 1 e após a 2. A terceira já não tenta de novo. */
export const BACKOFF_MS = [1000, 4000];

/** Pura: a espera base antes da próxima tentativa. */
export function esperaDeReintento(intentosHechos: number): number {
  const i = Math.min(Math.max(intentosHechos, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i] ?? 1000;
}

export type FilaDespacho = typeof schema.dispatch.$inferSelect;

/**
 * Enfileira (ou estende) o despacho de uma conversa.
 *
 * Idempotente por construção: se já houver um pendente, empurra sua janela em
 * vez de criar outro. Devolve QUANDO vence essa janela, para que quem enfileira
 * desperte o worker nesse instante em vez de esperar pelo seu próximo
 * varrimento.
 *
 * 025 — `messageIds` são as mensagens recebidas que provocam esta chamada. São anotadas na
 * linha viva —também se estiver EM VOO— porque são o que esse despacho deve
 * ao cérebro: a rajada sozinha não consegue dizê-lo (ver `rafagaDe`).
 */
export async function encolarDespacho(params: {
  organizationId: string;
  conversationId: string;
  messageIds?: readonly string[];
  ahora?: Date;
}): Promise<{ id: string; notBefore: Date }> {
  const db = getDb();
  const ahora = params.ahora ?? new Date();
  const notBefore = new Date(ahora.getTime() + ventanaCoalesceMs());
  const messageIds = [...new Set(params.messageIds ?? [])];
  // Concatena-se no SQL e não lendo-e-escrevendo: duas mensagens que chegam ao
  // mesmo tempo não podem sobrescrever a lista uma da outra.
  const anotados: { messageIds?: SQL } = messageIds.length
    ? {
        messageIds: sql`coalesce(${schema.dispatch.messageIds}, '[]'::jsonb) || ${JSON.stringify(messageIds)}::jsonb`,
      }
    : {};

  // Quase sempre uma volta. Repete-se só se a linha viva mudou sob os
  // pés: outra mensagem ganhou o índice único, ou o worker a pegou agora mesmo.
  for (let vuelta = 0; ; vuelta++) {
    const [vivo] = await db
      .select()
      .from(schema.dispatch)
      .where(
        and(
          eq(schema.dispatch.conversationId, params.conversationId),
          inArray(schema.dispatch.status, ["pendiente", "en_vuelo"])
        )
      )
      .limit(1);

    if (vivo) {
      // Em voo não se toca em `not_before`: o cérebro já tem o evento, sem
      // esta mensagem, e adiantar a janela não a faria chegar antes. Fica
      // anotado na linha, e o worker, ao entregá-la, vê que ainda continua
      // devendo e enfileira outro despacho.
      const enVuelo = vivo.status === "en_vuelo";
      if (enVuelo && !messageIds.length) {
        return { id: vivo.id, notBefore: vivo.notBefore };
      }
      /**
       * Só se AINDA estiver vivo.
       *
       * Entre o SELECT de cima e este UPDATE o worker pode ter terminado-o. O
       * anotado em uma linha já entregue não é relido por ninguém: essa
       * mensagem ficaria sem despacho. Se já não estiver vivo, abre a sua linha.
       */
      const [tocado] = await db
        .update(schema.dispatch)
        .set(
          enVuelo
            ? anotados
            : { notBefore, lastMessageAt: ahora, updatedAt: ahora, ...anotados }
        )
        .where(
          and(
            eq(schema.dispatch.id, vivo.id),
            eq(schema.dispatch.status, vivo.status)
          )
        )
        .returning({ notBefore: schema.dispatch.notBefore });
      if (tocado) return { id: vivo.id, notBefore: tocado.notBefore };
    }

    const id = newId("dispatch");
    try {
      await db.insert(schema.dispatch).values({
        id,
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        status: "pendiente",
        notBefore,
        firstMessageAt: ahora,
        lastMessageAt: ahora,
        messageIds: messageIds.length ? messageIds : null,
      });
      return { id, notBefore };
    } catch (err) {
      // Duas mensagens da mesma conversa entraram ao mesmo tempo e a outra ganhou
      // o índice único. A linha dela cobre esta mensagem, mas não a tem
      // anotada: recomeça-se para anotá-la nela.
      if (!esViolacionDeUnicidad(err)) throw err;
      if (vuelta >= 2 || !messageIds.length) return { id, notBefore };
    }
  }
}

/**
 * 025 — Os ids anotados na linha AGORA, não os que ela trazia quando foi reclamada.
 *
 * Enquanto o despacho ia em voo, podem ter sido anotados mais: são justamente os que
 * o evento não levou.
 */
export async function mensajesAnotados(fila: FilaDespacho): Promise<string[]> {
  const [row] = await getDb()
    .select({ messageIds: schema.dispatch.messageIds })
    .from(schema.dispatch)
    .where(
      and(
        eq(schema.dispatch.id, fila.id),
        eq(schema.dispatch.organizationId, fila.organizationId)
      )
    )
    .limit(1);
  return [...new Set(row?.messageIds ?? [])];
}

function esViolacionDeUnicidad(err: unknown): boolean {
  const code =
    (err as { code?: string })?.code ??
    (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/**
 * Pega até `limite` despachos cuja janela já venceu.
 *
 * O lease é o que permite que vários processos (ou o mesmo após reiniciar)
 * não se atropelem: marca-se `en_vuelo` com `leased_until`, e uma linha cujo lease
 * expirou volta a ficar disponível mesmo que continue marcada em voo.
 */
export async function tomarPendientes(
  limite = 10,
  ahora: Date = new Date()
): Promise<FilaDespacho[]> {
  const db = getDb();
  const candidatos = await db
    .select()
    .from(schema.dispatch)
    .where(
      or(
        and(
          eq(schema.dispatch.status, "pendiente"),
          lte(schema.dispatch.notBefore, ahora)
        ),
        // Lease vencido: o worker que a pegou morreu no meio.
        and(
          eq(schema.dispatch.status, "en_vuelo"),
          lte(schema.dispatch.leasedUntil, ahora)
        )
      )
    )
    .orderBy(schema.dispatch.notBefore)
    .limit(limite);

  const tomados: FilaDespacho[] = [];
  for (const fila of candidatos) {
    /**
     * A reclamação é este UPDATE, não o SELECT de cima, e se condiciona
     * ao estado e ao contador de tentativas.
     *
     * Comparar o timestamp parecia um trinco mais fino, mas é frágil de uma
     * forma silenciosa: o Postgres guarda microssegundos e o `Date` do JS só
     * milissegundos, então o valor relido pode não ser idêntico ao
     * armazenado e o UPDATE nunca casa. O contador inteiro distingue dois
     * donos mesmo que ambos vejam a linha em voo.
     */
    const res = await db
      .update(schema.dispatch)
      .set({
        status: "en_vuelo",
        leasedUntil: new Date(ahora.getTime() + LEASE_MS),
        attempts: fila.attempts + 1,
        updatedAt: ahora,
      })
      .where(
        and(
          eq(schema.dispatch.id, fila.id),
          eq(schema.dispatch.status, fila.status),
          eq(schema.dispatch.attempts, fila.attempts),
          fila.status === "en_vuelo"
            ? lte(schema.dispatch.leasedUntil, ahora)
            : lte(schema.dispatch.notBefore, ahora)
        )
      )
      .returning();
    if (res[0]) tomados.push(res[0]);
  }
  return tomados;
}

/** A linha continua sendo de quem a pegou. */
function propietario(fila: FilaDespacho) {
  return and(
    eq(schema.dispatch.id, fila.id),
    eq(schema.dispatch.status, "en_vuelo"),
    eq(schema.dispatch.attempts, fila.attempts)
  );
}

export async function renovarLease(fila: FilaDespacho): Promise<boolean> {
  const rows = await getDb()
    .update(schema.dispatch)
    .set({ leasedUntil: new Date(Date.now() + LEASE_MS) })
    .where(propietario(fila))
    .returning({ id: schema.dispatch.id });
  return rows.length === 1;
}

export async function marcarEntregado(fila: FilaDespacho): Promise<boolean> {
  const rows = await getDb()
    .update(schema.dispatch)
    .set({
      status: "entregado",
      leasedUntil: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(propietario(fila))
    .returning({ id: schema.dispatch.id });
  return rows.length === 1;
}

/**
 * Reprograma mais uma tentativa, ou expira se não restarem.
 * Devolve `true` se expirou (quem chama passa a conversa para um humano).
 */
export async function reintentarOCaducar(
  fila: FilaDespacho,
  detalle: string,
  ahora: Date = new Date()
): Promise<boolean> {
  if (fila.attempts >= MAX_INTENTOS) return caducarAHumano(fila, detalle);

  const base = esperaDeReintento(fila.attempts);
  // Variação: sem ela, N despachos que falharam ao mesmo tempo tentam de novo ao
  // mesmo tempo e derrubam de novo o cérebro que mal se levantava.
  const espera = base + Math.floor(Math.random() * base * 0.3);
  await getDb()
    .update(schema.dispatch)
    .set({
      status: "pendiente",
      notBefore: new Date(ahora.getTime() + espera),
      leasedUntil: null,
      lastError: detalle.slice(0, 300),
      updatedAt: ahora,
    })
    .where(propietario(fila));
  return false;
}

/** Expira sem mais tentativas. `true` se a linha era nossa e ficou expirada. */
export async function caducarAHumano(
  fila: FilaDespacho,
  detalle: string
): Promise<boolean> {
  const rows = await getDb()
    .update(schema.dispatch)
    .set({
      status: "caducado_a_humano",
      leasedUntil: null,
      lastError: detalle.slice(0, 300),
      updatedAt: new Date(),
    })
    .where(propietario(fila))
    .returning({ id: schema.dispatch.id });
  return rows.length === 1;
}

/**
 * O turno não deve mais existir: a IA foi pausada durante a janela, alguém
 * respondeu à mão, ou a conversa já não existe.
 *
 * Não é uma falha do cérebro nem precisa de aviso. Por isso não passa por
 * `caducarAHumano`, que conta como queda e pausa a conversa.
 */
export async function descartarDespacho(
  fila: FilaDespacho,
  detalle: string
): Promise<void> {
  await getDb()
    .update(schema.dispatch)
    .set({
      status: "descartado",
      leasedUntil: null,
      lastError: detalle.slice(0, 300),
      updatedAt: new Date(),
    })
    .where(propietario(fila));
}

/**
 * O cérebro não conseguiu receber o turno: a conversa passa para um humano.
 *
 * É a transferência que já existe — a mesma que deixa `POST /api/bot/handoff` e o
 * mesmo motivo (`error`) que um cérebro usa quando não consegue responder —, e
 * publica o mesmo evento, então a caixa de entrada o vê ao vivo. Só escreve na
 * transição: não sobrescreve a hora nem o motivo de uma transferência anterior.
 */
export async function pasarAHumano(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const ahora = new Date();
  const rows = await getDb()
    .update(schema.conversation)
    .set({
      aiEnabled: false,
      handoffAt: ahora,
      handoffReason: "error",
      updatedAt: ahora,
    })
    .where(
      and(
        eq(schema.conversation.id, conversationId),
        eq(schema.conversation.organizationId, organizationId),
        isNull(schema.conversation.handoffAt)
      )
    )
    .returning({ id: schema.conversation.id });
  if (!rows[0]) return;
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversationId, handoffReason: "error" } },
  });
}
