import { eq, gte, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { dayLabelInTz, timeInTz } from "@/lib/time/slots";
import { agendaEnabled } from "@/server/agenda/flag";
import { getSettings } from "@/server/agenda/settings";

/**
 * 015 — Os agendamentos do contato, para o contexto de um cérebro externo
 * (`GET /api/bot/context` → `booking`).
 *
 * Existe porque, sem isto, um cérebro só sabe de um agendamento pelo que
 * lembra da conversa. Na edição cloud, onde isto foi visto primeiro, isso
 * deu três falhas com a mesma origem: reservou um agendamento NOVO para quem não
 * chegou ao seu (o antigo continuou «agendado»), repetiu a um cliente às
 * cinco da tarde que a demo dele era «hoje às 10:30», e diante de «passa o link»
 * escalou para um humano em vez de mandar o link que o CRM tinha guardado.
 * A Nea já sabe ler este bloco (`_booking_lines` no seu `prompt.py`); o que
 * faltava era que a raiz o enviasse.
 *
 * A FORMA é a da edição cloud, para que um mesmo cérebro sirva às
 * duas (mais `status` nos vigentes, que é aditivo). Três agendamentos, porque
 * pedem respostas distintas:
 * - `next`: o próximo «agendado». É o que `PATCH /api/bot/bookings` move.
 * - `unresolved`: o último que JÁ começou (até 7 dias atrás) e ninguém fechou.
 *   O cliente que escreve «não consegui entrar» fala deste; dá-lo como vigente
 *   é justamente o erro que é preciso evitar. Com `endUtc` se sabe se continua
 *   em curso.
 * - `lastClosed`: o último que foi FECHADO há pouco (cancelado, não compareceu ou
 *   realizado). Sem ele, a quem cancelaram o agendamento pelo painel o agente
 *   respondeu «não ficou guardado, por algum motivo»: via o agendamento no
 *   histórico, não no contexto, e inventou o motivo.
 *
 * Um agendamento de TESTE (`is_test`, do Laboratório) jamais aparece aqui: é de
 * um cliente simulado, e apresentá-lo como real faria o cérebro negar ou proteger um
 * agendamento que não existe. Os bloqueios do operador também não: não são de ninguém.
 */

/** Até quando atrás um agendamento não fechado continua sendo assunto de conversa. */
export const DIAS_SIN_CERRAR = 7;

/** Até quando atrás um agendamento fechado continua sendo assunto de conversa. */
export const DIAS_CERRADA = 7;

const DIA_MS = 86_400_000;

export type CitaEnContexto = {
  id: string;
  /** Sempre `agendada`: os encerrados vão em `lastClosed`. */
  status: "agendada";
  startUtc: string;
  endUtc: string;
  /** O dia por extenso e a hora, na zona do negócio: "hoje segunda-feira, 14 de setembro, 10:30". */
  label: string;
  meetingLink: string | null;
  /** true ⇒ o agendamento existe, mas o provedor ainda não entregou o link. */
  linkPending: boolean;
};

export type EstadoCerrada = "cancelada" | "no_show" | "realizada";

export type CitaCerrada = {
  id: string;
  status: EstadoCerrada;
  startUtc: string;
  endUtc: string;
  label: string;
  /** Quando foi fechado (a última escrita do agendamento). */
  closedAt: string;
  /**
   * Só em `cancelada`. Na raiz é sempre `equipo`: cancelar não existe
   * por `/api/bot/*` (essa decisão é do dono e o caminho é o handoff) nem
   * para o agente in-process, então só se cancela pelo painel. O
   * campo vai igual para que a forma seja a da edição cloud, onde o
   * cérebro pode cancelar e aparece `agente`.
   */
  cancelledBy: "equipo" | null;
  // Sem link de propósito: o de um agendamento fechado já não serve.
};

export type CitasEnContexto = {
  /** Zona do negócio, na qual estão as etiquetas. */
  timezone: string;
  next: CitaEnContexto | null;
  unresolved: CitaEnContexto | null;
  lastClosed: CitaCerrada | null;
};

/** O agendamento tal como sai do banco, antes de escolher e dar forma. */
export type FilaCita = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | EstadoCerrada;
  isTest: boolean;
  scheduledAt: Date;
  durationMinutes: number;
  meetingLink: string | null;
  linkPending: boolean;
  updatedAt: Date;
};

function forma(fila: FilaCita, timezone: string, now: Date) {
  const startUtc = fila.scheduledAt.toISOString();
  return {
    id: fila.id,
    startUtc,
    endUtc: new Date(
      fila.scheduledAt.getTime() + fila.durationMinutes * 60_000
    ).toISOString(),
    label: `${dayLabelInTz(startUtc, timezone, now)}, ${timeInTz(startUtc, timezone)}`,
  };
}

function vigente(fila: FilaCita, timezone: string, now: Date): CitaEnContexto {
  return {
    ...forma(fila, timezone, now),
    status: "agendada",
    meetingLink: fila.meetingLink,
    linkPending: fila.linkPending,
  };
}

function cerrada(fila: FilaCita, timezone: string, now: Date): CitaCerrada {
  const status = fila.status as EstadoCerrada;
  return {
    ...forma(fila, timezone, now),
    status,
    closedAt: fila.updatedAt.toISOString(),
    cancelledBy: status === "cancelada" ? "equipo" : null,
  };
}

/**
 * PURA: dos agendamentos do contato, escolhe os três que importam e lhes dá forma.
 *
 * O filtro de teste e de bloqueios mora AQUI, não só na consulta: é a
 * garantia, e assim a fixa um teste sem banco de dados.
 */
export function citasEnContexto(
  filas: FilaCita[],
  timezone: string,
  now: Date
): CitasEnContexto {
  const reales = filas.filter((f) => !f.isTest && f.kind === "session");
  const agendadas = reales.filter((f) => f.status === "agendada");
  const t = now.getTime();

  const next = agendadas
    .filter((f) => f.scheduledAt.getTime() >= t)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0];

  const unresolved = agendadas
    .filter((f) => {
      const inicio = f.scheduledAt.getTime();
      return inicio < t && inicio >= t - DIAS_SIN_CERRAR * DIA_MS;
    })
    .sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())[0];

  const lastClosed = reales
    .filter(
      (f) =>
        f.status !== "agendada" && f.updatedAt.getTime() >= t - DIAS_CERRADA * DIA_MS
    )
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

  return {
    timezone,
    next: next ? vigente(next, timezone, now) : null,
    unresolved: unresolved ? vigente(unresolved, timezone, now) : null,
    lastClosed: lastClosed ? cerrada(lastClosed, timezone, now) : null,
  };
}

/**
 * O bloco `booking` do contexto, ou `null` quando não deve ir.
 *
 * `null` com a agenda desligada: nessa instância não há agendamentos sobre
 * os quais falar, e um bloco vazio faria o cérebro crer que os consultou e que o
 * lead não tem nenhum. Nem sequer se toca no banco.
 *
 * `null` também se a leitura falhar. A agenda é um módulo opcional e o
 * contexto é o que deixa o cérebro responder: sem contexto ele se cala, e
 * calar o cliente por não poder consultar a agenda seria pior que não
 * mencioná-la. Sem bloco, o cérebro não afirma nada sobre agendamentos.
 */
export async function citasParaContexto(
  organizationId: string,
  contactId: string,
  now = new Date()
): Promise<CitasEnContexto | null> {
  if (!agendaEnabled()) return null;
  try {
    return await leerCitas(organizationId, contactId, now);
  } catch (err) {
    console.error(
      `[agenda] no pude leer las citas del contacto ${contactId} para el contexto:`,
      err
    );
    return null;
  }
}

async function leerCitas(
  organizationId: string,
  contactId: string,
  now: Date
): Promise<CitasEnContexto> {
  const db = getDb();
  const desdeSinCerrar = new Date(now.getTime() - DIAS_SIN_CERRAR * DIA_MS);
  const desdeCerrada = new Date(now.getTime() - DIAS_CERRADA * DIA_MS);

  const [settings, filas] = await Promise.all([
    getSettings(organizationId),
    db
      .select({
        id: schema.booking.id,
        kind: schema.booking.kind,
        status: schema.booking.status,
        isTest: schema.booking.isTest,
        scheduledAt: schema.booking.scheduledAt,
        durationMinutes: schema.booking.durationMinutes,
        meetingLink: schema.booking.meetingLink,
        linkPending: schema.booking.linkPending,
        updatedAt: schema.booking.updatedAt,
      })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.contactId, contactId),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.isTest, false),
          // O único que pode sair: o que vem ou começou há pouco, e
          // o que se fechou há pouco. Limita a leitura a um punhado de linhas.
          or(
            gte(schema.booking.scheduledAt, desdeSinCerrar),
            gte(schema.booking.updatedAt, desdeCerrada)
          )
        )
      ),
  ]);

  return citasEnContexto(filas, settings.timezone, now);
}
