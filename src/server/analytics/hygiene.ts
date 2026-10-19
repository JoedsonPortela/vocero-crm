import { and, asc, desc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { sumable } from "@/lib/money";
import type { HygieneBlockDto } from "@/lib/analytics";
import { notLabContact } from "@/server/analytics/shared";

/**
 * 019 — Bloco de higiene.
 *
 * NÃO é análise histórica: descreve o AGORA, e por isso não recebe intervalo de
 * datas. É o que faz a tela ser aberta todo dia, em vez de uma vez por
 * mês.
 */

/** Dias sem que o cliente fale, a partir dos quais o lead está frio. */
export const SILENCIO_DIAS = 7;
/** Quantos leads em silêncio são listados; o total vai à parte. */
export const MAX_SILENCIOSOS = 50;

export async function hygieneBlock(
  organizationId: string,
  businessCurrency: string,
  now: Date = new Date()
): Promise<HygieneBlockDto> {
  const [silencio, failedMessages, closingWindows] = await Promise.all([
    leadsEnSilencio(organizationId, businessCurrency, now),
    mensajesFallidos(organizationId, now),
    ventanasPorVencer(organizationId, now),
  ]);

  return {
    silent: silencio.lista,
    silentCount: silencio.total,
    silentAmountCents: silencio.totalCents,
    failedMessages,
    closingWindows,
    clean:
      silencio.total === 0 &&
      failedMessages.length === 0 &&
      closingWindows.length === 0,
  };
}

/**
 * Leads abertos sem resposta do cliente há mais de uma semana, com o dinheiro
 * que está esfriando.
 *
 * O silêncio é medido pela última vez que FALOU O CLIENTE, não pela última
 * vez que algo aconteceu: mandar três follow-ups a um lead morto faria ele parecer
 * "ativo" justo quando mais precisa de atenção.
 *
 * O total e o dinheiro saem de funções de janela, calculadas ANTES
 * do limite: a lista é cortada em 50, os números não.
 */
async function leadsEnSilencio(organizationId: string, businessCurrency: string, now: Date) {
  const corte = new Date(now.getTime() - SILENCIO_DIAS * 86_400_000);
  // `mapWith`: um timestamp em SQL cru chega como texto SEM fuso, e
  // `new Date()` o leria na hora local do servidor. O mapeador da
  // coluna o lê como UTC, que é o que ela guarda.
  const ultimo = sql<Date>`coalesce(${schema.conversation.lastInboundAt}, ${schema.lead.lastActivityAt}, ${schema.lead.createdAt})`.mapWith(
    schema.lead.createdAt
  );

  const rows = await getDb()
    .select({
      leadId: schema.lead.id,
      contactId: schema.contact.id,
      name: schema.contact.name,
      amountCents: schema.lead.amountCents,
      currency: schema.lead.currency,
      ultimo,
      total: sql<number>`(count(*) over ())::int`,
      totalCents: sql<string>`coalesce(sum(case when ${schema.lead.amountCents} is not null and coalesce(${schema.lead.currency}, ${businessCurrency}) = ${businessCurrency} then ${schema.lead.amountCents} end) over (), 0)::bigint`,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.lead.contactId))
    .innerJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .leftJoin(
      schema.conversation,
      and(
        eq(schema.conversation.contactId, schema.lead.contactId),
        eq(schema.conversation.isTest, false)
      )
    )
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.pipelineStage.kind, "open"),
        isNull(schema.contact.archivedAt),
        notLabContact(schema.lead.contactId),
        // O instante vai como texto com cast explícito: dentro de um
        // `coalesce` o tipo do parâmetro é desconhecido e o driver não sabe
        // serializar um Date contra "unknown".
        sql`${ultimo} < ${corte.toISOString()}::timestamp`
      )
    )
    // O mais frio primeiro: se houver mais de 50, veem-se os que mais urge resgatar.
    .orderBy(asc(ultimo))
    .limit(MAX_SILENCIOSOS);

  const lista = rows
    .map((r) => ({
      leadId: r.leadId,
      contactId: r.contactId,
      name: r.name,
      days: Math.floor((now.getTime() - r.ultimo.getTime()) / 86_400_000),
      // Só o dinheiro na moeda do negócio entra no total em risco.
      amountCents: sumable({ amountCents: r.amountCents, currency: r.currency }, businessCurrency)
        ? r.amountCents
        : null,
    }))
    .sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0) || b.days - a.days);

  return {
    lista,
    total: rows[0]?.total ?? 0,
    totalCents: Number(rows[0]?.totalCents ?? 0),
  };
}

/** Saídas que não chegaram nos últimos 30 dias, por motivo. */
async function mensajesFallidos(organizationId: string, now: Date) {
  const desde = new Date(now.getTime() - 30 * 86_400_000);

  const rows = await getDb()
    .select({
      error: schema.message.error,
      n: sql<number>`count(*)::int`,
      lastAt: sql<Date>`max(${schema.message.createdAt})`.mapWith(schema.message.createdAt),
    })
    .from(schema.message)
    // O Laboratório não envia nada à Meta, mas se algo seu tiver ficado com falha
    // não é uma mensagem que o negócio tenha perdido.
    .innerJoin(
      schema.conversation,
      and(
        eq(schema.conversation.id, schema.message.conversationId),
        eq(schema.conversation.isTest, false)
      )
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.status, "failed"),
        gt(schema.message.createdAt, desde)
      )
    )
    .groupBy(schema.message.error)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  return rows.map((r) => ({
    error: r.error ?? "Sin detalle",
    count: r.n,
    lastAt: r.lastAt.toISOString(),
  }));
}

/**
 * Conversas em que a janela de 24 h está prestes a fechar e o negócio ainda
 * não respondeu.
 *
 * Passada essa janela só se pode escrever com template: é a diferença
 * entre responder de graça e gastar uma.
 */
async function ventanasPorVencer(organizationId: string, now: Date) {
  const limite = new Date(now.getTime() - 20 * 3_600_000);
  const vencida = new Date(now.getTime() - 24 * 3_600_000);

  const rows = await getDb()
    .select({
      conversationId: schema.conversation.id,
      contactId: schema.conversation.contactId,
      name: schema.contact.name,
      lastInboundAt: schema.conversation.lastInboundAt,
    })
    .from(schema.conversation)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        isNotNull(schema.conversation.lastInboundAt),
        lt(schema.conversation.lastInboundAt, limite),
        gt(schema.conversation.lastInboundAt, vencida),
        // Sem resposta nossa posterior à última coisa que o cliente disse.
        sql`(${schema.conversation.lastMessageAt} is null or ${schema.conversation.lastMessageAt} <= ${schema.conversation.lastInboundAt})`
      )
    )
    // A que fecha primeiro, no topo.
    .orderBy(asc(schema.conversation.lastInboundAt))
    .limit(20);

  return rows.map((r) => ({
    conversationId: r.conversationId,
    contactId: r.contactId,
    name: r.name,
    hoursLeft:
      Math.round(
        ((r.lastInboundAt!.getTime() + 24 * 3_600_000 - now.getTime()) / 3_600_000) * 10
      ) / 10,
  }));
}
