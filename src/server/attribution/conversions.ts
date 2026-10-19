import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { sendBusinessMessagingEvent } from "@/lib/meta/capi";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { atribucionEnabled } from "@/server/attribution/flag";
import { getCapiSettings } from "@/server/attribution/settings";
import { getAttributionForConversation } from "@/server/attribution/store";

/**
 * 016 — Reporte de conversões à Meta.
 *
 * Três regras rígidas, e nenhuma é opcional:
 *
 * 1. **Dedup na base**, não no código: a linha é inserida ANTES de falar
 *    com a Meta, com `ON CONFLICT DO NOTHING` sobre (org, conversa, evento).
 *    Não se pode desenviar uma compra à Meta.
 * 2. **Best-effort absoluto**: nada do que acontecer aqui —Meta fora do ar, token
 *    vencido, dataset não configurado— pode impedir que o lead mude de
 *    etapa. Registra-se o desfecho e segue-se.
 * 3. **Toda tentativa deixa rastro**: `sent`, `failed` ou `skipped` com o motivo
 *    escrito. As linhas `skipped` são a resposta a "por que este lead não
 *    aparece na Meta?", que sem elas se responde adivinhando.
 */

/** Os dois eventos que a Vocero emite (nomes do catálogo da Meta, tal como são). */
export const QUALIFIED_EVENT = "QualifiedLead";
export const PURCHASE_EVENT = "Purchase";

const NO_CLID_REASON =
  "sin ctwa_clid: la conversación no vino de un anuncio de WhatsApp";
const NOT_CONFIGURED_REASON =
  "atribución no configurada: falta el dataset de Meta o la conexión de WhatsApp";

type EmitOutcome = "sent" | "failed" | "skipped" | "dedup" | "error";

/**
 * Reporta um evento de uma conversa. Público para que um fork possa emitir
 * os seus (p. ex. o espelho `InitiateCheckout` que o guia documenta) sem
 * reimplementar o dedup nem o tratamento da confirmação.
 */
export async function emitConversion(
  organizationId: string,
  conversationId: string,
  eventName: string,
  customData?: Record<string, unknown>
): Promise<EmitOutcome> {
  try {
    const db = getDb();

    // Dedup atômico: se esse evento já existe para esta conversa, não faz nada.
    const inserted = await db
      .insert(schema.conversionEvent)
      .values({
        id: newId("conversionEvent"),
        organizationId,
        conversationId,
        eventName,
      })
      .onConflictDoNothing({
        target: [
          schema.conversionEvent.organizationId,
          schema.conversionEvent.conversationId,
          schema.conversionEvent.eventName,
        ],
      })
      .returning();

    const event = inserted[0];
    if (!event) return "dedup";

    const attribution = await getAttributionForConversation(
      organizationId,
      conversationId
    );
    const settings = await getCapiSettings(organizationId);
    const credentials = await getCredentialsByOrg(organizationId);

    if (!attribution?.ctwaClid || !settings || !credentials) {
      await db
        .update(schema.conversionEvent)
        .set({
          status: "skipped",
          attributionId: attribution?.id ?? null,
          error: !attribution?.ctwaClid ? NO_CLID_REASON : NOT_CONFIGURED_REASON,
        })
        .where(eq(schema.conversionEvent.id, event.id));
      return "skipped";
    }

    try {
      const ack = await sendBusinessMessagingEvent({
        datasetId: settings.datasetId,
        token: settings.token,
        event: {
          eventName,
          eventTime: Math.floor(Date.now() / 1000),
          ctwaClid: attribution.ctwaClid,
          wabaId: credentials.wabaId,
          customData,
        },
      });
      await db
        .update(schema.conversionEvent)
        .set({
          status: "sent",
          attributionId: attribution.id,
          sentAt: new Date(),
          fbTraceId: ack.fbTraceId,
          error: null,
        })
        .where(eq(schema.conversionEvent.id, event.id));
      return "sent";
    } catch (err) {
      await db
        .update(schema.conversionEvent)
        .set({
          status: "failed",
          attributionId: attribution.id,
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(schema.conversionEvent.id, event.id));
      console.warn(
        `[capi] fallo al reportar ${eventName} de ${conversationId}: ${err}`
      );
      return "failed";
    }
  } catch (err) {
    // Best-effort absoluto: nem mesmo uma falha do banco pode derrubar
    // quem nos chamou (mover um lead de etapa).
    console.warn(`[capi] emitConversion(${eventName}) falló: ${err}`);
    return "error";
  }
}

/**
 * `custom_data` de um `Purchase` a partir do valor do negócio. Pura e exportada
 * para fixar num teste a conversão de centavos → unidades: a Meta espera unidades
 * da moeda (450.50) e o banco guarda centavos inteiros (45050).
 *
 * Sem valor (ou com zero) devolve só a etapa: a venda é contada igual, mas
 * sem preço. Enviar `value: 0` não significa "não sei quanto" — ensina ao
 * otimizador que as vendas deste negócio valem nada.
 */
export function purchaseCustomData(amount: {
  amountCents: number | null;
  currency: string | null;
}): Record<string, unknown> {
  const base = { lead_stage: "won" };
  if (amount.amountCents === null || amount.amountCents <= 0) return base;
  return {
    ...base,
    value: amount.amountCents / 100,
    ...(amount.currency ? { currency: amount.currency } : {}),
  };
}

/**
 * Ponto de entrada a partir da porta única de etapas.
 *
 * Mora aqui e não em `stage-history.ts` para que aquele arquivo continue sendo o
 * que diz ser: a porta que escreve `stage_id`. E pendura-se nessa porta —e não
 * em onde o bot escreve a ficha, como no fork de onde vem esta ideia—
 * porque assim reportam IGUAL os quatro caminhos que movem um lead: o dono
 * arrastando, o agente incluído, um cérebro externo por `/api/bot/*` e
 * qualquer quinto caminho que alguém adicione amanhã.
 */
export async function reportStageChange(input: {
  organizationId: string;
  leadId: string;
  contactId: string;
  toStageId: string;
  toStageKind: "open" | "won" | "lost";
}): Promise<void> {
  if (!atribucionEnabled()) return;

  try {
    const settings = await getCapiSettings(input.organizationId);
    const isQualified =
      settings?.qualifiedStageId != null &&
      settings.qualifiedStageId === input.toStageId;
    const isWon = input.toStageKind === "won";
    if (!isQualified && !isWon) return;

    const db = getDb();
    // A conversa REAL do contato (índice único parcial: uma por
    // contato). As do Laboratório (`is_test`) não entram aqui — mesma
    // proteção do sender: uma conversa de teste jamais toca o
    // mundo real.
    const rows = await db
      .select({
        conversationId: schema.conversation.id,
        amountCents: schema.lead.amountCents,
        currency: schema.lead.currency,
      })
      .from(schema.lead)
      .innerJoin(
        schema.conversation,
        and(
          eq(schema.conversation.organizationId, schema.lead.organizationId),
          eq(schema.conversation.contactId, schema.lead.contactId),
          eq(schema.conversation.isTest, false)
        )
      )
      .where(
        scoped(
          schema.lead.organizationId,
          input.organizationId,
          eq(schema.lead.id, input.leadId)
        )
      )
      .limit(1);

    const row = rows[0];
    // Sem conversa de WhatsApp não há `ctwa_clid` possível nem nada que
    // atribuir (p. ex. um prospecto capturado à mão que nunca escreveu).
    if (!row) return;

    if (isWon) {
      await emitConversion(
        input.organizationId,
        row.conversationId,
        PURCHASE_EVENT,
        purchaseCustomData(row)
      );
      return;
    }

    await emitConversion(
      input.organizationId,
      row.conversationId,
      QUALIFIED_EVENT,
      { lead_stage: "qualified" }
    );
  } catch (err) {
    console.warn(`[capi] reportStageChange(${input.leadId}) falló: ${err}`);
  }
}

/* ---------------- Atividade recente (somente leitura) ---------------- */

export type ConversionActivityRow = {
  id: string;
  conversationId: string;
  eventName: string;
  /** Nome do contato; null se a conversa já não existir. */
  contactName: string | null;
  /** Titular do anúncio de origem, se foi capturado. */
  adHeadline: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
  /** Momento a mostrar: o envio se ocorreu, senão a criação. */
  at: string;
  fbTraceId: string | null;
  error: string | null;
};

/** Teto rígido: é um painel de monitoramento, não uma exportação. */
const ACTIVITY_MAX_LIMIT = 50;
export const ACTIVITY_DEFAULT_LIMIT = 25;

/** Pura e exportada para testar o fallback de data sem tocar a base. */
export function toConversionActivityRow(row: {
  id: string;
  conversationId: string;
  eventName: string;
  status: "pending" | "sent" | "failed" | "skipped";
  error: string | null;
  fbTraceId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  contactName: string | null;
  adHeadline: string | null;
}): ConversionActivityRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    eventName: row.eventName,
    contactName: row.contactName,
    adHeadline: row.adHeadline,
    status: row.status,
    at: (row.sentAt ?? row.createdAt).toISOString(),
    fbTraceId: row.fbTraceId,
    error: row.error,
  };
}

/** Últimas conversões da organização, a mais recente primeiro. */
export async function listConversionActivity(
  organizationId: string,
  limit = ACTIVITY_DEFAULT_LIMIT
): Promise<ConversionActivityRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.conversionEvent.id,
      conversationId: schema.conversionEvent.conversationId,
      eventName: schema.conversionEvent.eventName,
      status: schema.conversionEvent.status,
      error: schema.conversionEvent.error,
      fbTraceId: schema.conversionEvent.fbTraceId,
      sentAt: schema.conversionEvent.sentAt,
      createdAt: schema.conversionEvent.createdAt,
      contactName: schema.contact.name,
      adHeadline: schema.adAttribution.headline,
    })
    .from(schema.conversionEvent)
    .leftJoin(
      schema.conversation,
      eq(schema.conversation.id, schema.conversionEvent.conversationId)
    )
    .leftJoin(
      schema.contact,
      eq(schema.contact.id, schema.conversation.contactId)
    )
    .leftJoin(
      schema.adAttribution,
      eq(schema.adAttribution.conversationId, schema.conversionEvent.conversationId)
    )
    .where(scoped(schema.conversionEvent.organizationId, organizationId))
    .orderBy(desc(schema.conversionEvent.createdAt))
    .limit(Math.min(Math.max(limit, 1), ACTIVITY_MAX_LIMIT));

  return rows.map(toConversionActivityRow);
}
