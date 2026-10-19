import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, createSessionBooking } from "@/server/agenda/service";

/**
 * 015 — O que o agente incluído pode fazer com a agenda.
 *
 * Mora aqui e não no pipeline para que o pipeline não aprenda sobre agendas: o
 * turno pede "ofertar" ou "reservar" e recebe o texto que deve ser enviado.
 *
 * Regra que atravessa as duas operações: o modelo NÃO redige horários. Pede
 * ofertar, e o motor cola as etiquetas reais. Se o modelo inventa um
 * instante ao reservar, o motor o rejeita e se re-oferta — nunca se agenda
 * algo que o cliente não escolheu.
 */

/** Quantos horários são mostrados ao cliente em uma mensagem. */
const SHOWN = 3;
/** Quantos são guardados como reserváveis: o catálogo é mais amplo que o menu. */
const OFFERED = 12;

export type AgendaTurn = {
  /** O que deve ser enviado ao cliente. */
  text: string;
  /** false ⇒ o motor não conseguiu; o turno segue, sem agendar. */
  ok: boolean;
};

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
  });
  const spread = spreadByDay(all, {
    timezone: settings.timezone,
    limit: OFFERED,
    perDay: 3,
    now,
  });

  if (spread.length === 0) {
    // Agenda lotada não é um erro: é uma resposta que o cliente entende.
    return {
      ok: false,
      text:
        input.intro?.trim() ||
        "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  // Registra-se TODO o catálogo, não só o que se mostra: se o cliente pedir
  // outro dia, o agente tem alternativas legítimas para aceitar.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    spread.map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  const shown = spread.slice(0, SHOWN);
  const lista = shown.map((s) => `• ${s.dayLabel} às ${s.time}`).join("\n");
  const intro = input.intro?.trim() || "Tengo estos horarios disponibles:";
  return { ok: true, text: `${intro}\n${lista}` };
}

export async function bookSlot(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  confirmation?: string;
}): Promise<AgendaTurn> {
  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      source: "ai",
      requireOffer: true,
    });

    const base =
      input.confirmation?.trim() || `¡Listo! Te agendé para ${result.label}.`;
    if (result.meetingLink) {
      return { ok: true, text: `${base}\nEnlace: ${result.meetingLink}` };
    }
    if (result.linkPending) {
      // O agendamento existe; o link não. Não se promete o que não se tem.
      return {
        ok: true,
        text: `${base}\nEn un momento te comparto el enlace por aquí.`,
      };
    }
    return { ok: true, text: base };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // Ou o horário foi ocupado ou o modelo inventou a hora: nos dois casos re-oferta-se com
    // dados reais em vez de discutir com o cliente.
    if (err.slots.length > 0) {
      const lista = err.slots
        .slice(0, SHOWN)
        .map((s) => `• ${s.label}`)
        .join("\n");
      const disculpa =
        err.code === "slot_taken"
          ? "Se me acaba de ocupar ese horario, ¡perdón!"
          : "Déjame confirmarte los horarios que tengo:";
      return { ok: false, text: `${disculpa}\n${lista}` };
    }
    return {
      ok: false,
      text: "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.",
    };
  }
}
