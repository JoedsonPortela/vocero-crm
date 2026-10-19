import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { labelInTz } from "@/lib/time/slots";
import { CONNECTOR_META, type ConnectorId } from "@/lib/agenda-connectors";
import {
  computeAvailability,
  findSlot,
  type AvailableSlot,
} from "@/server/agenda/availability";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import {
  clearOffers,
  findOffered,
  getOffers,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import {
  bindConnector,
  markConnectorAuthError,
} from "@/server/agenda/connectors";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { publish } from "@/server/events/bus";

/**
 * 015 — Ciclo de vida do agendamento e as duas regras INEGOCIÁVEIS:
 *
 *  1. Quem conduz a conversa (agente in-process ou cérebro externo) só
 *     pode reservar um instante que já foi ofertado a ESTA conversa
 *     (`offered_slot`, comparação por epoch exato).
 *  2. Ao confirmar, revalida-se o horário e o banco o fecha com seu índice
 *     único parcial; se estiver ocupado, responde-se `slot_taken` com alternativas
 *     frescas e NADA é criado. Nunca se confirma uma reserva que não foi criada.
 *
 * E uma regra de honestidade: a entrega da reunião (o conector) roda
 * DEPOIS de gravar a verdade do CRM e é best-effort. Se o provedor estiver
 * fora do ar, o agendamento é criado mesmo assim com o link pendente — um terceiro não pode
 * nos custar a conversão, nem nos fazer prometer um link que não existe.
 */

export type BookingErrorCode =
  | "slot_taken"
  | "slot_not_offered"
  | "not_found"
  | "invalid";

export class BookingError extends Error {
  code: BookingErrorCode;
  /**
   * Horários para re-ofertar. Em `slot_taken` são alternativas frescas JÁ
   * registradas como a nova oferta da conversa; em `slot_not_offered`
   * é o que de fato tinha sido ofertado.
   */
  slots: OfferedSlot[];

  constructor(
    code: BookingErrorCode,
    message: string,
    slots: OfferedSlot[] = []
  ) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.slots = slots;
  }
}

type BookingRow = typeof schema.booking.$inferSelect;

export type BookingResult = {
  booking: BookingRow;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

/** Quantas alternativas são devolvidas quando o horário foi ocupado. */
const FRESH_ALTERNATIVES = 3;

export async function createSessionBooking(input: {
  organizationId: string;
  startUtc: string;
  source: "manual" | "ai";
  /** Obrigatória no caminho conversacional; dela sai o contato. */
  conversationId?: string | null;
  /** Caminho manual do operador. */
  contactId?: string | null;
  notes?: string | null;
  /**
   * true ⇒ exige que o instante conste entre os ofertados à conversa
   * (agente/bot). O operador escolhe da disponibilidade que está vendo, então
   * reserva sem oferta prévia.
   */
  requireOffer: boolean;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const settings = await getSettings(input.organizationId);

  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }

  // Contexto da conversa: contato e se é do Laboratório.
  let isTest = false;
  let contactId = input.contactId ?? null;
  let contactName = "";
  if (input.conversationId) {
    const rows = await db
      .select({
        contactId: schema.conversation.contactId,
        isTest: schema.conversation.isTest,
      })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          input.organizationId,
          eq(schema.conversation.id, input.conversationId)
        )
      )
      .limit(1);
    const conv = rows[0];
    if (!conv) throw new BookingError("not_found", "Conversación no encontrada");
    isTest = conv.isTest;
    contactId = contactId ?? conv.contactId;
  }

  if (!contactId) {
    throw new BookingError("invalid", "La cita necesita un contacto");
  }
  contactName = await getContactName(input.organizationId, contactId);

  // REGRA 1: só se reserva o que foi ofertado.
  if (input.requireOffer) {
    if (!input.conversationId) {
      throw new BookingError(
        "invalid",
        "Se necesita la conversación para validar la oferta"
      );
    }
    const offers = await getOffers(input.organizationId, input.conversationId);
    if (!findOffered(offers, input.startUtc)) {
      throw new BookingError(
        "slot_not_offered",
        "Ese horario no se ofreció en esta conversación",
        offers
      );
    }
  }

  // REGRA 2 (primeira metade): o horário deve continuar livre AGORA.
  const slot = await findSlot(input.organizationId, input.startUtc, {
    now: input.now,
    settings,
  });
  if (!slot) {
    throw new BookingError(
      "slot_taken",
      "Ese horario ya no está disponible",
      await refreshOffer(input.organizationId, input.conversationId, {
        now: input.now,
      })
    );
  }

  const leadRows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        input.organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);

  let booking: BookingRow;
  try {
    const inserted = await db
      .insert(schema.booking)
      .values({
        id: newId("booking"),
        organizationId: input.organizationId,
        kind: "session",
        source: input.source === "ai" ? "ai" : "manual",
        contactId,
        conversationId: input.conversationId ?? null,
        leadId: leadRows[0]?.id ?? null,
        scheduledAt: new Date(slot.startUtc),
        durationMinutes: settings.slotMinutes,
        // Cópia histórica: se o negócio trocar de conector, este agendamento mantém
        // o que lhe coube e continua falando com ele ao ser movido ou cancelado.
        connector: settings.connector,
        isTest,
        notes: input.notes ?? null,
      })
      .returning();
    booking = inserted[0]!;
  } catch (err) {
    // REGRA 2 (segunda metade): a chave única fecha a corrida exata. Duas
    // confirmações simultâneas do mesmo instante — a perdedora sai por
    // aqui, sem agendamento criado.
    if (isUniqueViolation(err)) {
      throw new BookingError(
        "slot_taken",
        "Ese horario acaba de ocuparse",
        await refreshOffer(input.organizationId, input.conversationId, {
          now: input.now,
        })
      );
    }
    throw err;
  }

  // A oferta cumpriu seu propósito.
  if (input.conversationId) {
    await clearOffers(input.organizationId, input.conversationId).catch(
      (err) => {
        console.warn(`[agenda] no pude limpiar la oferta: ${err}`);
      }
    );
  }

  // Efeitos colaterais: nenhum pode reverter o agendamento.
  const delivered = await deliverMeeting(booking, settings, contactName);
  await advanceLeadStage(
    input.organizationId,
    contactId,
    input.source === "ai" ? "bot" : "dueno"
  ).catch((err) => {
    console.warn(`[agenda] avance de etapa falló: ${err}`);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });

  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

export async function createBlock(input: {
  organizationId: string;
  startUtc: string;
  durationMinutes: number;
  notes?: string | null;
}): Promise<BookingRow> {
  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }
  const db = getDb();
  try {
    const inserted = await db
      .insert(schema.booking)
      .values({
        id: newId("booking"),
        organizationId: input.organizationId,
        kind: "block",
        source: "manual",
        scheduledAt: new Date(input.startUtc),
        durationMinutes: input.durationMinutes,
        notes: input.notes ?? null,
      })
      .returning();
    const block = inserted[0]!;
    publish(input.organizationId, {
      type: "booking.updated",
      data: { bookingId: block.id },
    });
    return block;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  }
}

export async function rescheduleBooking(input: {
  organizationId: string;
  bookingId: string;
  startUtc: string;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.status === "cancelada") {
    throw new BookingError("invalid", "La cita está cancelada");
  }

  const settings = await getSettings(input.organizationId);
  // excludeBookingId: o próprio agendamento não deve bloquear a si mesmo.
  const slot = await findSlot(input.organizationId, input.startUtc, {
    excludeBookingId: booking.id,
    now: input.now,
    settings,
  });
  if (!slot) {
    throw new BookingError("slot_taken", "Ese horario ya no está disponible");
  }

  let next: BookingRow;
  try {
    const updated = await db
      .update(schema.booking)
      .set({ scheduledAt: new Date(slot.startUtc), updatedAt: new Date() })
      .where(eq(schema.booking.id, booking.id))
      .returning();
    next = updated[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario acaba de ocuparse");
    }
    throw err;
  }

  // Mover a reunião no provedor mantém o link: é a MESMA reunião,
  // em outro horário. Uma falha aqui não desfaz nada — o link anterior segue
  // funcionando na prática.
  await withConnector(next, settings, async (conn, externalRef) => {
    await conn.updateMeeting(externalRef, {
      startUtc: slot.startUtc,
      durationMinutes: next.durationMinutes,
      timezone: settings.timezone,
    });
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: next.id },
  });
  return {
    booking: next,
    meetingLink: next.meetingLink,
    linkPending: next.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

/**
 * Reagenda o PRÓXIMO agendamento ativo da conversa. É o caminho do
 * agente: mover um agendamento não deveria obrigar a pausar a IA e passar o
 * problema para um humano.
 */
export async function rescheduleForConversation(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const now = input.now ?? new Date();

  const convRows = await db
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new BookingError("not_found", "Conversación no encontrada");

  // Mesmas regras de criar: o novo instante precisa ter sido ofertado.
  const offers = await getOffers(input.organizationId, input.conversationId);
  if (!findOffered(offers, input.startUtc)) {
    throw new BookingError(
      "slot_not_offered",
      "Ese horario no se ofreció en esta conversación",
      offers
    );
  }

  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        input.organizationId,
        and(
          eq(schema.booking.contactId, conv.contactId),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.status, "agendada"),
          gte(schema.booking.scheduledAt, now)
        )
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(1);

  const target = rows[0];
  if (!target) {
    throw new BookingError("not_found", "No hay una cita activa que mover");
  }

  const result = await rescheduleBooking({
    organizationId: input.organizationId,
    bookingId: target.id,
    startUtc: input.startUtc,
    now: input.now,
  });
  await clearOffers(input.organizationId, input.conversationId).catch(() => {});
  return result;
}

/** Idempotente: cancelar um agendamento já cancelado não falha nem muda nada. */
export async function cancelBooking(input: {
  organizationId: string;
  bookingId: string;
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.status === "cancelada") return;

  await db
    .update(schema.booking)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(eq(schema.booking.id, booking.id));

  const settings = await getSettings(input.organizationId);
  await withConnector(booking, settings, async (conn, externalRef) => {
    await conn.deleteMeeting(externalRef);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });
}

export async function markBookingStatus(input: {
  organizationId: string;
  bookingId: string;
  status: "realizada" | "no_show";
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  try {
    await db
      .update(schema.booking)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(schema.booking.id, booking.id));
  } catch (err) {
    // Reativar para `realizada` um instante que outro agendamento já ocupa.
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  }
  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });
}

/**
 * Tenta de novo a entrega de um agendamento que ficou sem link porque o provedor
 * falhou. Fala com o conector com o qual o agendamento NASCEU, não com o ativo.
 *
 * Sem isso, um soluço do provedor seria uma perda silenciosa que ninguém
 * conserta — que é exatamente o que acontece hoje no fork.
 */
export async function retryMeetingLink(input: {
  organizationId: string;
  bookingId: string;
}): Promise<BookingResult> {
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (!booking.linkPending) {
    throw new BookingError("invalid", "Esta cita no tiene un enlace pendiente");
  }
  const settings = await getSettings(input.organizationId);
  const contactName = booking.contactId
    ? await getContactName(input.organizationId, booking.contactId)
    : "";
  const delivered = await deliverMeeting(booking, settings, contactName);

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });
  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(delivered.scheduledAt.toISOString(), settings.timezone),
  };
}

/**
 * Cria a reunião no provedor e a guarda no agendamento.
 *
 * SANDBOX: um agendamento do Laboratório jamais chega a um conector. A asserção fica
 * aqui, ANTES de resolver qual é, para que valha igual para todos — hoje e
 * para o que for adicionado num fork amanhã.
 */
async function deliverMeeting(
  booking: BookingRow,
  settings: CalendarSettings,
  contactName: string
): Promise<BookingRow> {
  if (booking.isTest) return booking;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;

  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );

    // Se o agendamento JÁ tem reunião, isto é uma nova tentativa: relê-se, não
    // cria-se outra. Sem esta ramificação, tentar de novo o link de um evento do Google
    // deixaria o dono com dois agendamentos na sua agenda.
    const meeting =
      booking.externalRef && conn.refreshMeeting
        ? await conn.refreshMeeting(booking.externalRef)
        : await conn.createMeeting({
            topic: contactName ? `Cita — ${contactName}` : "Cita",
            startUtc: booking.scheduledAt.toISOString(),
            durationMinutes: booking.durationMinutes,
            timezone: settings.timezone,
            notes: booking.notes ?? undefined,
          });

    return await persistDelivery(booking.id, {
      externalRef: meeting.externalId ?? booking.externalRef,
      meetingLink: meeting.joinUrl,
      // Um conector que promete link por agendamento e ainda não o trouxe deixa o
      // agendamento "sem link" — reintentável. O `enlace-fijo` sem sala configurada,
      // em compensação, não tem nada pendente: simplesmente não há link.
      linkPending: CONNECTOR_META[connectorId].perBookingLink && !meeting.joinUrl,
    });
  } catch (err) {
    console.warn(
      `[agenda] el conector ${connectorId} no pudo entregar la reunión: ${err}`
    );
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
    // O agendamento já existe e fica: o link é o único que falta. Mantém-se a
    // referência externa se ela já existia, para que a nova tentativa
    // saiba que não deve criar outra reunião.
    return await persistDelivery(booking.id, {
      externalRef: booking.externalRef,
      meetingLink: null,
      linkPending: true,
    });
  }
}

async function persistDelivery(
  bookingId: string,
  values: {
    externalRef: string | null;
    meetingLink: string | null;
    linkPending: boolean;
  }
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .update(schema.booking)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.booking.id, bookingId))
    .returning();
  return rows[0]!;
}

/**
 * Executa um efeito sobre o provedor de um agendamento já criado (mover, apagar).
 * Best-effort e com a mesma proteção de sandbox. Sem `external_ref` não há
 * nada a mover: o conector não gerou reunião (p. ex. o link fixo).
 */
async function withConnector(
  booking: BookingRow,
  settings: CalendarSettings,
  run: (
    conn: Awaited<ReturnType<typeof bindConnector>>,
    externalRef: string
  ) => Promise<void>
): Promise<void> {
  if (booking.isTest || !booking.externalRef) return;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;
  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );
    await run(conn, booking.externalRef);
  } catch (err) {
    console.warn(`[agenda] efecto en ${connectorId} falló: ${err}`);
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
  }
}

/**
 * Alternativas frescas para re-ofertar. Se houver conversa, ficam
 * REGISTRADAS como a sua nova oferta: o cliente pode aceitar uma de imediato
 * e a validação continuará válida.
 */
async function refreshOffer(
  organizationId: string,
  conversationId: string | null | undefined,
  opts: { now?: Date }
): Promise<OfferedSlot[]> {
  let fresh: AvailableSlot[] = [];
  try {
    fresh = (await computeAvailability(organizationId, { now: opts.now })).slice(
      0,
      FRESH_ALTERNATIVES
    );
  } catch (err) {
    console.warn(`[agenda] no pude calcular alternativas: ${err}`);
    return [];
  }
  const offers: OfferedSlot[] = fresh.map((s) => ({
    startUtc: s.startUtc,
    label: s.label,
  }));
  if (conversationId && offers.length > 0) {
    await replaceOffers(organizationId, conversationId, offers).catch((err) => {
      console.warn(`[agenda] no pude registrar la nueva oferta: ${err}`);
    });
  }
  return offers;
}

async function getOwnBooking(
  organizationId: string,
  bookingId: string
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new BookingError("not_found", "Cita no encontrada");
  return rows[0];
}

async function getContactName(
  organizationId: string,
  contactId: string
): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ name: schema.contact.name })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  return rows[0]?.name ?? "";
}

/**
 * O lead avança para a próxima etapa aberta ao agendar — só para a frente,
 * nunca retrocede.
 *
 * Passa por `moveLeadToStage`, a única porta que pode escrever `stage_id`:
 * mover o lead e registrar a movimentação no histórico são a mesma
 * operação. Escrever o UPDATE aqui não quebra na hora, só faz os gráficos
 * mentirem meses depois — e há um teste de vigilância que impede isso.
 */
async function advanceLeadStage(
  organizationId: string,
  contactId: string,
  source: "bot" | "dueno"
): Promise<void> {
  const db = getDb();
  const leads = await db
    .select({ id: schema.lead.id, stageId: schema.lead.stageId })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const lead = leads[0];
  if (!lead) return;

  const stages = await db
    .select({
      id: schema.pipelineStage.id,
      position: schema.pipelineStage.position,
      kind: schema.pipelineStage.kind,
    })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const currentIdx = stages.findIndex((s) => s.id === lead.stageId);
  if (currentIdx < 0) return;
  const nextOpen = stages.find((s, i) => i > currentIdx && s.kind === "open");
  if (!nextOpen) return; // já está na última etapa aberta (ou em uma âncora)

  await moveLeadToStage({
    organizationId,
    leadId: lead.id,
    toStageId: nextOpen.id,
    source,
    extra: { lastActivityAt: new Date() },
  });
}

/** Agendamentos que ocupam a agenda de verdade. */
export const ACTIVE_STATUSES = ["agendada", "realizada"] as const;

/** Há algum agendamento ativo para este contato? Usado pelo agente. */
export async function hasActiveBooking(
  organizationId: string,
  contactId: string,
  now = new Date()
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        and(
          eq(schema.booking.contactId, contactId),
          eq(schema.booking.kind, "session"),
          inArray(schema.booking.status, [...ACTIVE_STATUSES]),
          gte(schema.booking.scheduledAt, now)
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** 23505 = unique_violation de Postgres. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  // O Drizzle envolve o erro do driver: o código real vai em `cause`.
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}
