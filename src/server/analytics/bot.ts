import { eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  HANDOFF_LABEL,
  rate,
  type BotBlockDto,
  type LabeledCountDto,
  type SessionsDto,
} from "@/lib/analytics";
import { agendaEnabled } from "@/server/agenda/flag";
import { median, type ResolvedPeriod } from "@/server/analytics/period";
import { notLabContact } from "@/server/analytics/shared";

/**
 * 019 — O trabalho do agente.
 *
 * Ficam as medidas que valem para qualquer negócio —respondeu, quanto
 * demorou, quantas vezes passou para um humano, como saíram os agendamentos. Todas olham
 * a MESMA coorte: as conversas que começaram no período. Assim uma
 * taxa não pode passar de 100 % por contar no numerador escalonamentos de
 * conversas antigas que o denominador não tem.
 *
 * Só conversas reais: o Laboratório escala de propósito (sua persona
 * «pede humano») e responde sempre; contá-lo faria o agente parecer melhor e pior
 * do que é.
 */
export async function botBlock(
  organizationId: string,
  period: ResolvedPeriod,
  agenda: boolean = agendaEnabled()
): Promise<BotBlockDto> {
  const { start, end } = period;

  const [conteos, primera, handoffs, sesiones, ficha] = await Promise.all([
    conteosDeLaCohorte(organizationId, start, end),
    medianaPrimeraRespuesta(organizationId, start, end),
    escalamientos(organizationId, start, end),
    // Sem a bandeira não há agenda, e sem agenda não há agendamentos a contar: nem
    // sequer se consulta (spec 019, D4).
    agenda ? sesionesDelPeriodo(organizationId, start, end) : Promise.resolve(null),
    coberturaDeFicha(organizationId, start, end),
  ]);

  const escalados = handoffs.reduce((a, h) => a + h.count, 0);

  return {
    period: period.dto,
    conversations: conteos.total,
    aiReplyRate: rate(conteos.contestoElAgente, conteos.conEntrante),
    firstResponseSeconds: primera.median,
    firstResponseSample: primera.sample,
    handoffs,
    handoffRate: rate(escalados, conteos.total),
    sessions: sesiones,
    fichaCoverage: ficha,
    empty: conteos.total === 0 && (sesiones?.booked ?? 0) === 0,
  };
}

/**
 * A conversa de fora, para as subconsultas correlacionadas, com seu
 * nome de tabela ESCRITO. Na lista de SELECT de uma consulta de uma só
 * tabela, o drizzle tira a tabela de toda coluna interpolada: `${id}` sairia
 * como `"id"`, e dentro de `from "message" m` isso é `m.id` — a subconsulta se
 * compararia consigo mesma e a primeira resposta sairia sempre vazia.
 */
const conversacionId = sql.raw(`"conversation"."id"`);

/** As conversas reais que começaram no intervalo. */
function cohorte(organizationId: string, start: Date, end: Date) {
  return scoped(
    schema.conversation.organizationId,
    organizationId,
    eq(schema.conversation.isTest, false),
    gte(schema.conversation.createdAt, start),
    lt(schema.conversation.createdAt, end)
  );
}

/**
 * Quantas são, em quantas o cliente escreveu e em quantas dessas o
 * agente respondeu. «O agente» é toda saída com origem IA: o in-process e um
 * cérebro externo por `/api/bot/messages` gravam igual.
 */
async function conteosDeLaCohorte(organizationId: string, start: Date, end: Date) {
  const entrante = sql`exists (select 1 from "message" mi where mi."conversation_id" = ${conversacionId} and mi."direction" = 'in')`;
  const delAgente = sql`exists (select 1 from "message" mo where mo."conversation_id" = ${conversacionId} and mo."direction" = 'out' and mo."origin" = 'ai')`;
  const rows = await getDb()
    .select({
      total: sql<number>`count(*)::int`,
      conEntrante: sql<number>`count(*) filter (where ${entrante})::int`,
      contestoElAgente: sql<number>`count(*) filter (where ${entrante} and ${delAgente})::int`,
    })
    .from(schema.conversation)
    .where(cohorte(organizationId, start, end));
  return {
    total: rows[0]?.total ?? 0,
    conEntrante: rows[0]?.conEntrante ?? 0,
    contestoElAgente: rows[0]?.contestoElAgente ?? 0,
  };
}

/**
 * Mediana —não média— do tempo até a primeira resposta do agente.
 *
 * Uma conversa que ficou travada oito horas puxaria a média para cima e
 * faria parecer lento um agente que responde em segundos.
 */
async function medianaPrimeraRespuesta(
  organizationId: string,
  start: Date,
  end: Date
): Promise<{ median: number | null; sample: number }> {
  const primerEntrante = sql`(select min(m1."created_at") from "message" m1
    where m1."conversation_id" = ${conversacionId} and m1."direction" = 'in')`;
  const rows = await getDb()
    .select({
      segundos: sql<number | null>`extract(epoch from (
        (select min(m2."created_at") from "message" m2
          where m2."conversation_id" = ${conversacionId}
            and m2."direction" = 'out' and m2."origin" = 'ai'
            and m2."created_at" > ${primerEntrante})
        - ${primerEntrante}
      ))`,
    })
    .from(schema.conversation)
    .where(cohorte(organizationId, start, end));

  const valores = rows
    .map((r) => (r.segundos === null ? null : Number(r.segundos)))
    .filter((v): v is number => v !== null && v >= 0);

  return { median: median(valores), sample: valores.length };
}

/** Da coorte, as que hoje estão nas mãos de um humano, por motivo. */
async function escalamientos(
  organizationId: string,
  start: Date,
  end: Date
): Promise<LabeledCountDto[]> {
  const rows = await getDb()
    .select({
      reason: schema.conversation.handoffReason,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        gte(schema.conversation.createdAt, start),
        lt(schema.conversation.createdAt, end),
        isNotNull(schema.conversation.handoffAt)
      )
    )
    .groupBy(schema.conversation.handoffReason);

  return rows
    .map((r) => {
      const key = r.reason ?? "sin_motivo";
      return {
        key,
        label: HANDOFF_LABEL[key] ?? "Sin motivo registrado",
        count: r.n,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Agendamentos do período por desfecho. Os de teste não são agendamentos. */
async function sesionesDelPeriodo(
  organizationId: string,
  start: Date,
  end: Date
): Promise<SessionsDto> {
  const rows = await getDb()
    .select({ status: schema.booking.status, n: sql<number>`count(*)::int` })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        eq(schema.booking.isTest, false),
        gte(schema.booking.scheduledAt, start),
        lt(schema.booking.scheduledAt, end)
      )
    )
    .groupBy(schema.booking.status);

  const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const done = n("realizada");
  const noShow = n("no_show");
  return {
    booked: rows.reduce((a, r) => a + r.n, 0),
    done,
    noShow,
    cancelled: n("cancelada"),
    // Contra os que CHEGARAM na hora, não contra todos: um agendamento cancelado
    // com aviso não é um não comparecimento, e incluí-lo no denominador faria parecer ruim um
    // negócio cujos clientes avisam.
    showRate: rate(done, done + noShow),
  };
}

/**
 * Que parte dos contatos novos tem ficha.
 *
 * Devolve `null` quando NENHUM contato real tem ficha: isso não é «0 % de
 * cobertura», é que o agente desta instância não a escreve e a medida não
 * se aplica. Mostrar 0 % ali seria acusá-lo de não fazer algo que nunca lhe
 * foi pedido.
 */
async function coberturaDeFicha(organizationId: string, start: Date, end: Date) {
  const db = getDb();
  const conFicha = sql`${schema.contact.ficha} is not null and ${schema.contact.ficha}::text <> '{}'`;
  const [cohorteContactos, alguna] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        conFicha: sql<number>`count(*) filter (where ${conFicha})::int`,
      })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          gte(schema.contact.createdAt, start),
          lt(schema.contact.createdAt, end),
          notLabContact(schema.contact.id)
        )
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          conFicha,
          notLabContact(schema.contact.id)
        )
      ),
  ]);

  if ((alguna[0]?.n ?? 0) === 0) return null;
  return rate(cohorteContactos[0]?.conFicha ?? 0, cohorteContactos[0]?.total ?? 0);
}
