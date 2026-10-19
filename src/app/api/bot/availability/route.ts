import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { scoped } from "@/lib/db/tenant";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { addDaysISO, todayInTz } from "@/lib/time/slots";
import {
  buildCandidateSlots,
  computeAvailability,
} from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { armarHuecos, daysWithAgenda } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";

export const dynamic = "force-dynamic";

/**
 * 015 — Os horários que serão oferecidos ao cliente, para quem conduz a
 * conversa.
 *
 * Diferentemente da visão do operador, esta REGISTRA a oferta: é esse
 * registro que depois habilita a reserva. Sem ele, `POST /api/bot/bookings`
 * recusa qualquer instante.
 *
 * O catálogo reservável (`limit`) é mais amplo que o menu que o agente
 * mostra: guardar só os três exibidos deixa o agente sem nada
 * legítimo para aceitar quando o cliente pede outro dia.
 *
 * Sem `date` é uma DISTRIBUIÇÃO (até `perDay` horas de cada dia) e `query` diz
 * até onde vai. Com `date=YYYY-MM-DD` (dia no fuso do negócio)
 * devolve as horas livres DAQUELE dia, distribuídas ao longo do dia, e
 * `query.status` diz por que não há nenhuma. Sem isso, para «amanhã à
 * tarde?» o cérebro só via as três primeiras horas da manhã e respondia
 * que só havia manhã (`src/server/agenda/spread.ts`, `armarHuecos`).
 */

const LIMITS = {
  limit: { min: 1, max: 48, def: 12 },
  perDay: { min: 1, max: 8, def: 3 },
  days: { min: 1, max: 14, def: 5 },
};

function clamp(raw: string | null, l: { min: number; max: number; def: number }) {
  // Ausente ou vazio ⇒ o default do contrato. `Number(null)` é 0, não NaN:
  // sem esse corte, pedir sem parâmetros dava UM horário de UM dia.
  if (raw === null || raw.trim() === "") return l.def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return l.def;
  return Math.max(l.min, Math.min(l.max, Math.round(n)));
}

export async function GET(req: Request) {
  // A flag é avaliada ANTES da chave: se esta instância não tem
  // agenda, o endpoint não existe — não há nada para autenticar.
  if (!agendaEnabled()) return agendaDisabledResponse();

  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "A instância ainda não tem organização");
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    return apiError(422, "invalid_body", "Falta conversationId");
  }
  // `date` é opcional; vazio conta como ausente. Mal formada ou inexistente
  // no calendário (2026-02-31) → 422, nunca um 500 nem a distribuição silenciosa.
  const date = url.searchParams.get("date")?.trim() || null;
  if (date !== null && !fechaValida(date)) {
    return apiError(
      422,
      "invalid_body",
      "date debe ser una fecha real en formato YYYY-MM-DD"
    );
  }

  const db = getDb();
  const rows = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  if (!rows[0]) return apiError(404, "not_found", "Conversa não encontrada");

  const limit = clamp(url.searchParams.get("limit"), LIMITS.limit);
  const perDay = clamp(url.searchParams.get("perDay"), LIMITS.perDay);
  const days = clamp(url.searchParams.get("days"), LIMITS.days);

  const settings = await getSettings(organizationId);
  const now = new Date();
  const hoy = todayInTz(now, settings.timezone);
  // Um dia fora do agendável nem é calculado: não há nada para buscar.
  const dentro =
    !date || (date >= hoy && date <= addDaysISO(hoy, settings.maxDaysAhead));
  const todos = dentro
    ? await computeAvailability(organizationId, {
        settings,
        now,
        ...(date ? { fromISO: date, toISO: date } : {}),
      })
    : [];
  const { slots, query } = armarHuecos({
    todos,
    timezone: settings.timezone,
    now,
    maxDaysAhead: settings.maxDaysAhead,
    limit,
    perDay,
    days,
    date,
    candidatosDelDia:
      date && dentro ? buildCandidateSlots(settings, date, date).length : 0,
  });

  // Substituição completa: a oferta vigente é sempre a última. Mas uma
  // consulta por dia que não achou nada NÃO apaga o que já foi oferecido: o cliente
  // que pergunta pelo sábado e ouve «esse dia não abrimos» ainda pode
  // ficar com a sexta que lhe foi dada antes.
  if (!date || slots.length > 0) {
    await replaceOffers(
      organizationId,
      conversationId,
      slots.map((s) => ({ startUtc: s.startUtc, label: s.label }))
    );
  }

  return Response.json({
    slots: slots.map((s) => ({
      startUtc: s.startUtc,
      endUtc: s.endUtc,
      label: s.label,
      dayIso: s.dayIso,
      dayLabel: s.dayLabel,
      time: s.time,
    })),
    // Os dias que NÃO estão aqui não têm agenda ATÉ `query.coveredUntil`:
    // o posterior não foi revisado, e de cada dia são vistas até `query.perDay`
    // horas. Para um dia específico, pergunta-se com `date`.
    diasConAgenda: daysWithAgenda(slots),
    query,
  });
}

/** YYYY-MM-DD que também existe no calendário (nada de 2026-02-31). */
function fechaValida(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
