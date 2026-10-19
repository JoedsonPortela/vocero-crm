import { asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { sumable } from "@/lib/money";
import {
  bucketsDelPeriodo,
  comparable,
  rate,
  type FunnelStepDto,
  type LossReasonRowDto,
  type SalesBlockDto,
  type StageKind,
  type StageTimingDto,
} from "@/lib/analytics";
import { LOSS_REASON_LABEL, type LossReason } from "@/lib/types";
import type { ResolvedPeriod } from "@/server/analytics/period";
import { localDateExpr, notLabContact } from "@/server/analytics/shared";

/**
 * 019 — Bloco de vendas e funil.
 *
 * Quase tudo é agregado em SQL: trazer os leads para o Node para somá-los aguenta 200
 * e cai com 20 000, justo quando o negócio crescer e a tela importar
 * mais. A exceção é o desfecho de cada lead, que o banco resolve com um
 * DISTINCT ON e aqui só se distribui em faixas.
 *
 * Portado do Vocero Cloud sem o «dinheiro esperado»: precisa da probabilidade
 * de fechamento do lead, uma coluna que a raiz não tem (spec 019, D5).
 */
export async function salesBlock(
  organizationId: string,
  period: ResolvedPeriod,
  businessCurrency: string
): Promise<SalesBlockDto> {
  const { start, end, previousStart, previousEnd } = period;

  // O desfecho de cada lead é resolvido UMA vez e daí saem os
  // indicadores, a série e os motivos de perda. Se cada bloco o deduzisse
  // por conta própria, poderiam se contradizer na mesma tela.
  const [desenlaces, desenlacesPrev] = await Promise.all([
    desenlacesDelPeriodo(organizationId, start, end),
    desenlacesDelPeriodo(organizationId, previousStart, previousEnd),
  ]);
  const cerrados = clasificarCierres(desenlaces, businessCurrency);
  const cerradosPrev = clasificarCierres(desenlacesPrev, businessCurrency);

  const [nuevos, nuevosPrev, timeToWinDays, serie, embudo, tiempos, completeFrom, vivo] =
    await Promise.all([
      contarNuevos(organizationId, start, end),
      contarNuevos(organizationId, previousStart, previousEnd),
      diasHastaGanar(organizationId, cerrados.won),
      serieTemporal(organizationId, period, cerrados.won, businessCurrency),
      embudoCohorte(organizationId, start, end),
      tiemposPorEtapa(organizationId, start, end),
      primerEventoReal(organizationId),
      pipelineVivo(organizationId, businessCurrency),
    ]);

  const wonCount = cerrados.won.length;
  const lostCount = cerrados.lost.length;

  // Ticket médio sobre os negócios que TÊM valor na moeda do
  // negócio: dividir por todos os ganhos castigaria a média com os
  // que ninguém capturou.
  const avgTicketCents =
    cerrados.wonWithAmount > 0
      ? Math.round(cerrados.wonCents / cerrados.wonWithAmount)
      : null;

  return {
    period: period.dto,
    kpis: {
      newLeads: comparable(nuevos, nuevosPrev),
      won: comparable(wonCount, cerradosPrev.won.length),
      lost: comparable(lostCount, cerradosPrev.lost.length),
      wonCents: comparable(cerrados.wonCents, cerradosPrev.wonCents),
      winRate: rate(wonCount, wonCount + lostCount),
      avgTicketCents,
    },
    pipeline: vivo,
    series: serie,
    funnel: embudo,
    timing: tiempos,
    timeToWinDays,
    completeFrom,
    lossReasons: motivosDePerdida(desenlaces),
    // "Vazio" fala do PERÍODO, não do painel: o funil de hoje quase sempre
    // tem algo, e se contasse um intervalo de 2020 nunca poderia se declarar vazio.
    empty: nuevos === 0 && wonCount === 0 && lostCount === 0,
  };
}

/** Prospectos que entraram: leads criados no intervalo, sem os do Laboratório. */
async function contarNuevos(
  organizationId: string,
  start: Date,
  end: Date
): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        gte(schema.lead.createdAt, start),
        lt(schema.lead.createdAt, end),
        notLabContact(schema.lead.contactId)
      )
    );
  return rows[0]?.n ?? 0;
}

type Cierres = {
  won: string[];
  lost: string[];
  wonCents: number;
  wonWithAmount: number;
};

export type Desenlace = {
  leadId: string;
  kind: StageKind;
  lossReason: LossReason | null;
  amountCents: number | null;
  currency: string | null;
};

/**
 * Como terminou cada lead que se moveu dentro do intervalo: seu ÚLTIMO movimento,
 * seja do tipo que for.
 *
 * Olhar só os eventos de fechamento não basta. Tirar um cartão de Ganho e
 * devolvê-lo ao funil deixa um evento `open`, então o último evento *de
 * fechamento* continuaria dizendo "ganho" e o negócio apareceria como venda —além
 * do mesmo dinheiro contado outra vez em "hoje no funil"—. E um negócio que se
 * ganha, se tira e se ganha de novo deixa dois eventos `won` do mesmo lead, que
 * somariam o valor duas vezes. Com o desfecho único os dois casos
 * desaparecem.
 */
async function desenlacesDelPeriodo(
  organizationId: string,
  start: Date,
  end: Date
): Promise<Desenlace[]> {
  return getDb()
    .selectDistinctOn([schema.leadStageEvent.leadId], {
      leadId: schema.leadStageEvent.leadId,
      kind: schema.leadStageEvent.toStageKind,
      lossReason: schema.leadStageEvent.lossReason,
      amountCents: schema.lead.amountCents,
      currency: schema.lead.currency,
    })
    .from(schema.leadStageEvent)
    .innerJoin(schema.lead, eq(schema.lead.id, schema.leadStageEvent.leadId))
    .where(
      scoped(
        schema.leadStageEvent.organizationId,
        organizationId,
        gte(schema.leadStageEvent.occurredAt, start),
        lt(schema.leadStageEvent.occurredAt, end),
        notLabContact(schema.leadStageEvent.contactId)
      )
    )
    .orderBy(
      schema.leadStageEvent.leadId,
      desc(schema.leadStageEvent.occurredAt),
      desc(schema.leadStageEvent.createdAt)
    );
}

/**
 * Negócios fechados no intervalo. Conta-se o LEAD, não o evento.
 *
 * O dinheiro sai do valor ATUAL do lead — não se guarda histórico do valor —,
 * e só soma o que está na moeda do negócio.
 */
export function clasificarCierres(
  desenlaces: Desenlace[],
  businessCurrency: string
): Cierres {
  const won: string[] = [];
  const lost: string[] = [];
  let wonCents = 0;
  let wonWithAmount = 0;

  for (const d of desenlaces) {
    // `open` = o lead voltou ao funil e não fechou nada neste intervalo.
    if (d.kind === "won") {
      won.push(d.leadId);
      if (sumable({ amountCents: d.amountCents, currency: d.currency }, businessCurrency)) {
        wonCents += d.amountCents!;
        wonWithAmount += 1;
      }
    } else if (d.kind === "lost") {
      lost.push(d.leadId);
    }
  }

  return { won, lost, wonCents, wonWithAmount };
}

/**
 * Dias desde que o prospecto entrou até ser ganho. Só com eventos
 * REAIS: os semeados pela migração trazem `updated_at` como data, que
 * qualquer edição posterior sobrescreveu, e contaminariam a média.
 */
async function diasHastaGanar(
  organizationId: string,
  leadIds: string[]
): Promise<number | null> {
  if (leadIds.length === 0) return null;
  const rows = await getDb()
    .select({
      dias: sql<number | null>`avg(extract(epoch from (${schema.leadStageEvent.occurredAt} - ${schema.lead.createdAt})) / 86400)::float`,
    })
    .from(schema.leadStageEvent)
    .innerJoin(schema.lead, eq(schema.lead.id, schema.leadStageEvent.leadId))
    .where(
      scoped(
        schema.leadStageEvent.organizationId,
        organizationId,
        inArray(schema.leadStageEvent.leadId, leadIds),
        eq(schema.leadStageEvent.toStageKind, "won"),
        eq(schema.leadStageEvent.approximate, false)
      )
    );
  const dias = rows[0]?.dias;
  return dias === null || dias === undefined ? null : Math.round(dias * 10) / 10;
}

/**
 * Série por dia ou por mês, cortada no fuso do negócio.
 *
 * `wonLeadIds` são os negócios que o período já deu como ganhos; a série NÃO
 * volta a decidir quem ganhou, só distribui esses mesmos no calendário. É o
 * que mantém o gráfico alinhado com o indicador de cima.
 */
async function serieTemporal(
  organizationId: string,
  period: ResolvedPeriod,
  wonLeadIds: string[],
  businessCurrency: string
): Promise<SalesBlockDto["series"]> {
  const db = getDb();
  const { start, end, timezone } = period;
  const porMes = period.dto.granularity === "month";

  const [nuevos, ganados] = await Promise.all([
    db
      .select({
        bucket: localDateExpr(schema.lead.createdAt, timezone, porMes),
        n: sql<number>`count(*)::int`,
      })
      .from(schema.lead)
      .where(
        scoped(
          schema.lead.organizationId,
          organizationId,
          gte(schema.lead.createdAt, start),
          lt(schema.lead.createdAt, end),
          notLabContact(schema.lead.contactId)
        )
      )
      // GROUP BY 1 (posição), não a expressão repetida: `localDateExpr` leva
      // parâmetros e o Postgres veria duas expressões diferentes.
      .groupBy(sql`1`),
    // Agrupa-se por (dia, lead) e NÃO só por dia: o dinheiro é do LEAD, e
    // somá-lo por evento faria um negócio ganho duas vezes valer o dobro.
    // O colapso para um único balde por lead é feito abaixo, em memória, porque
    // os fechamentos de um intervalo são poucos por natureza.
    wonLeadIds.length === 0
      ? []
      : db
          .select({
            bucket: localDateExpr(schema.leadStageEvent.occurredAt, timezone, porMes),
            leadId: schema.leadStageEvent.leadId,
            lastAt: sql<number>`extract(epoch from max(${schema.leadStageEvent.occurredAt}))::float`,
            cents: sql<number>`coalesce(max(case when ${schema.lead.amountCents} is not null and coalesce(${schema.lead.currency}, ${businessCurrency}) = ${businessCurrency} then ${schema.lead.amountCents} else 0 end), 0)::int`,
          })
          .from(schema.leadStageEvent)
          .innerJoin(schema.lead, eq(schema.lead.id, schema.leadStageEvent.leadId))
          .where(
            scoped(
              schema.leadStageEvent.organizationId,
              organizationId,
              gte(schema.leadStageEvent.occurredAt, start),
              lt(schema.leadStageEvent.occurredAt, end),
              eq(schema.leadStageEvent.toStageKind, "won"),
              inArray(schema.leadStageEvent.leadId, wonLeadIds)
            )
          )
          .groupBy(sql`1`, schema.leadStageEvent.leadId),
  ]);

  const buckets = new Map<string, SalesBlockDto["series"][number]>();
  for (const r of nuevos) {
    buckets.set(r.bucket, { bucket: r.bucket, newLeads: r.n, won: 0, wonCents: 0 });
  }
  // Um lead ganho em dois dias diferentes do intervalo continua sendo UM negócio: fica
  // no balde do seu último fechamento, que é o que o indicador conta.
  const ultimoBucket = new Map<string, { bucket: string; cents: number; at: number }>();
  for (const r of ganados) {
    const at = Number(r.lastAt);
    const previo = ultimoBucket.get(r.leadId);
    if (previo && previo.at >= at) continue;
    ultimoBucket.set(r.leadId, { bucket: r.bucket, cents: r.cents, at });
  }
  for (const g of ultimoBucket.values()) {
    const prev = buckets.get(g.bucket) ?? {
      bucket: g.bucket,
      newLeads: 0,
      won: 0,
      wonCents: 0,
    };
    prev.won += 1;
    prev.wonCents += g.cents;
    buckets.set(g.bucket, prev);
  }
  // Cada balde do período, com zero onde não aconteceu nada.
  return bucketsDelPeriodo(period.dto).map(
    (bucket) => buckets.get(bucket) ?? { bucket, newLeads: 0, won: 0, wonCents: 0 }
  );
}

/**
 * Funil de COORTE: dos prospectos que ENTRARAM no intervalo, quantos
 * chegaram a cada etapa (em qualquer momento, inclusive depois do intervalo).
 *
 * É a pergunta do dono — "de cada 100 que entram, quantos fecham" — e não a
 * mistura de coortes que daria contar eventos soltos.
 */
async function embudoCohorte(
  organizationId: string,
  start: Date,
  end: Date
): Promise<FunnelStepDto[]> {
  const db = getDb();

  const [etapas, alcanzadas] = await Promise.all([
    db
      .select()
      .from(schema.pipelineStage)
      .where(scoped(schema.pipelineStage.organizationId, organizationId))
      .orderBy(asc(schema.pipelineStage.position)),
    db
      .select({
        leadId: schema.leadStageEvent.leadId,
        maxOpenPos: sql<
          number | null
        >`max(case when ${schema.pipelineStage.kind} = 'open' then ${schema.pipelineStage.position} end)`,
        won: sql<number>`max(case when ${schema.leadStageEvent.toStageKind} = 'won' then 1 else 0 end)::int`,
      })
      .from(schema.leadStageEvent)
      .innerJoin(schema.lead, eq(schema.lead.id, schema.leadStageEvent.leadId))
      .leftJoin(
        schema.pipelineStage,
        eq(schema.pipelineStage.id, schema.leadStageEvent.toStageId)
      )
      .where(
        scoped(
          schema.leadStageEvent.organizationId,
          organizationId,
          gte(schema.lead.createdAt, start),
          lt(schema.lead.createdAt, end),
          notLabContact(schema.leadStageEvent.contactId)
        )
      )
      .groupBy(schema.leadStageEvent.leadId),
  ]);

  return armarEmbudo(etapas, alcanzadas);
}

/**
 * O funil a partir das etapas e de até onde chegou cada lead. À parte e
 * puro para poder testar suas regras sem base.
 *
 * Um lead conta UMA vez por etapa mesmo que tenha ido e voltado, e o acumulado
 * só percorre etapas ABERTAS: se "Perdido" tivesse uma posição alta, um
 * negócio perdido apareceria como se tivesse passado por todas.
 */
export function armarEmbudo(
  etapas: { id: string; name: string; kind: StageKind; position: number }[],
  alcanzadas: { maxOpenPos: number | null; won: number }[]
): FunnelStepDto[] {
  const abiertas = etapas.filter((s) => s.kind === "open");
  const ganada = etapas.find((s) => s.kind === "won");

  const pasos: FunnelStepDto[] = abiertas.map((s) => ({
    stageId: s.id,
    name: s.name,
    kind: s.kind,
    reached: alcanzadas.filter(
      (a) => a.maxOpenPos !== null && Number(a.maxOpenPos) >= s.position
    ).length,
    advanceRate: null,
  }));

  pasos.push({
    stageId: ganada?.id ?? null,
    name: ganada?.name ?? "Ganado",
    kind: "won",
    reached: alcanzadas.filter((a) => a.won === 1).length,
    advanceRate: null,
  });

  for (let i = 0; i < pasos.length - 1; i++) {
    pasos[i]!.advanceRate = rate(pasos[i + 1]!.reached, pasos[i]!.reached);
  }
  return pasos;
}

/**
 * Dias que um lead passa em cada etapa: diferença entre um evento e o
 * seguinte do mesmo lead, os dois dentro do intervalo e os dois REAIS. Um trecho
 * medido contra uma data semeada pela migração não mede nada.
 */
async function tiemposPorEtapa(
  organizationId: string,
  start: Date,
  end: Date
): Promise<StageTimingDto[]> {
  const rows = await getDb()
    .select({
      stageId: schema.leadStageEvent.toStageId,
      name: schema.leadStageEvent.toStageName,
      dias: sql<
        number | null
      >`extract(epoch from (lead(${schema.leadStageEvent.occurredAt}) over (partition by ${schema.leadStageEvent.leadId} order by ${schema.leadStageEvent.occurredAt}) - ${schema.leadStageEvent.occurredAt})) / 86400`,
    })
    .from(schema.leadStageEvent)
    .where(
      scoped(
        schema.leadStageEvent.organizationId,
        organizationId,
        eq(schema.leadStageEvent.approximate, false),
        gte(schema.leadStageEvent.occurredAt, start),
        lt(schema.leadStageEvent.occurredAt, end),
        notLabContact(schema.leadStageEvent.contactId)
      )
    );

  const porEtapa = new Map<string, { stageId: string | null; name: string; dias: number[] }>();
  for (const r of rows) {
    if (r.dias === null) continue;
    const key = r.stageId ?? r.name;
    const bucket = porEtapa.get(key) ?? { stageId: r.stageId, name: r.name, dias: [] };
    bucket.dias.push(Number(r.dias));
    porEtapa.set(key, bucket);
  }

  return [...porEtapa.values()]
    .map((b) => ({
      stageId: b.stageId,
      name: b.name,
      avgDays: Math.round((b.dias.reduce((a, d) => a + d, 0) / b.dias.length) * 10) / 10,
      sample: b.dias.length,
    }))
    .sort((a, b) => (b.avgDays ?? 0) - (a.avgDays ?? 0));
}

/**
 * Desde quando os tempos são completos: o primeiro evento observado de
 * verdade. Só importa se houver eventos SEMEADOS (o histórico foi instalado sobre
 * leads que já existiam); sem eles o histórico é completo desde o início e
 * não há nada a advertir.
 */
async function primerEventoReal(organizationId: string): Promise<string | null> {
  const rows = await getDb()
    .select({
      at: sql<Date | null>`min(${schema.leadStageEvent.occurredAt}) filter (where ${schema.leadStageEvent.approximate} = false)`.mapWith(
        schema.leadStageEvent.occurredAt
      ),
      sembrados: sql<number>`count(*) filter (where ${schema.leadStageEvent.approximate} = true)::int`,
    })
    .from(schema.leadStageEvent)
    .where(scoped(schema.leadStageEvent.organizationId, organizationId));
  if (!rows[0]?.sembrados) return null;
  return rows[0].at?.toISOString() ?? null;
}

/**
 * Motivos de perda do período. Sai do MESMO desfecho que os
 * indicadores: a tabela não pode contar um negócio que acima não é perdido.
 */
export function motivosDePerdida(desenlaces: Desenlace[]): LossReasonRowDto[] {
  const acc = new Map<LossReason | "sin_registro", LossReasonRowDto>();

  for (const d of desenlaces) {
    if (d.kind !== "lost") continue;
    const reason = d.lossReason ?? "sin_registro";
    const row = acc.get(reason) ?? {
      reason,
      label: d.lossReason ? LOSS_REASON_LABEL[d.lossReason] : "Sin motivo registrado",
      count: 0,
    };
    row.count += 1;
    acc.set(reason, row);
  }

  return [...acc.values()].sort((a, b) => b.count - a.count);
}

/**
 * O funil de HOJE: dinheiro das etapas abertas na moeda do negócio,
 * quantos não têm valor e quantos estão em outra moeda. Uma única passada em
 * SQL; a soma vai como `bigint` porque muitos valores de `integer` estouram o
 * `integer`.
 */
async function pipelineVivo(
  organizationId: string,
  businessCurrency: string
): Promise<SalesBlockDto["pipeline"]> {
  const mismaMoneda = sql`coalesce(${schema.lead.currency}, ${businessCurrency}) = ${businessCurrency}`;
  const rows = await getDb()
    .select({
      openCents: sql<string>`coalesce(sum(${schema.lead.amountCents}) filter (where ${schema.lead.amountCents} is not null and ${mismaMoneda}), 0)::bigint`,
      withoutAmount: sql<number>`count(*) filter (where ${schema.lead.amountCents} is null)::int`,
      otherCurrency: sql<number>`count(*) filter (where ${schema.lead.amountCents} is not null and not (${mismaMoneda}))::int`,
    })
    .from(schema.lead)
    .innerJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.pipelineStage.kind, "open"),
        notLabContact(schema.lead.contactId)
      )
    );

  const r = rows[0];
  return {
    openCents: Number(r?.openCents ?? 0),
    withoutAmount: r?.withoutAmount ?? 0,
    otherCurrency: r?.otherCurrency ?? 0,
  };
}
