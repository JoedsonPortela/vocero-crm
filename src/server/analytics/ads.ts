import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  comparable,
  rate,
  type AdRowDto,
  type AdsBlockDto,
  type SourceKey,
  type SourceRowDto,
} from "@/lib/analytics";
import { SOURCE_LABELS, SOURCE_VALUES } from "@/server/contact-source";
import type { ResolvedPeriod } from "@/server/analytics/period";
import {
  effectiveSourceExpr,
  firstAttributionIdExpr,
  notLabContact,
} from "@/server/analytics/shared";

/**
 * 019 — De onde chegam: por origem e por anúncio, SOMENTE em contagens.
 *
 * Sem gasto, custo ou retorno (spec 019, D1-D2): o único que a raiz sabe
 * de um anúncio é o que a Meta envia no `referral` do webhook, e a 018 já
 * guarda. Contar conversas, prospectos e vendas não exige a API de
 * Marketing nem um conector.
 *
 * Três contagens por linha, com significados que não se misturam:
 *  - conversas: as que COMEÇARAM no período;
 *  - prospectos: os leads criados no período;
 *  - vendas: desses prospectos, os que hoje estão em Ganho. É uma coorte de
 *    propósito: assim «vendas ÷ prospectos» é a conversão da linha e não
 *    pode passar de 100 %.
 */

const FUENTES: readonly SourceKey[] = [...SOURCE_VALUES, "desconocida"];

/** Quantas linhas a tabela por anúncio mostra: mais não se lê numa tela. */
export const MAX_ANUNCIOS = 50;

export async function adsBlock(
  organizationId: string,
  period: ResolvedPeriod
): Promise<AdsBlockDto> {
  const [convsPorFuente, leadsPorFuente, convsPorAnuncio, leadsPorAnuncio, previas] =
    await Promise.all([
      conversacionesPorFuente(organizationId, period.start, period.end),
      prospectosPorFuente(organizationId, period.start, period.end),
      conversacionesPorAnuncio(organizationId, period.start, period.end),
      prospectosPorAnuncio(organizationId, period.start, period.end),
      contarConversaciones(organizationId, period.previousStart, period.previousEnd),
    ]);

  const sources = unirFuentes(convsPorFuente, leadsPorFuente);
  const ads = unirAnuncios(convsPorAnuncio, leadsPorAnuncio);
  const conversaciones = sources.reduce((a, s) => a + s.conversations, 0);
  const deAnuncio = sources.find((s) => s.value === "anuncio")?.conversations ?? 0;
  const prospectos = sources.reduce((a, s) => a + s.leads, 0);

  return {
    period: period.dto,
    conversations: comparable(conversaciones, previas),
    adShare: rate(deAnuncio, conversaciones),
    sources,
    ads,
    empty: conversaciones === 0 && prospectos === 0,
  };
}

type Conteo = { key: string | null; n: number };
type ConteoLeads = { key: string | null; leads: number; won: number };

/** Conversas reais que começaram no intervalo, pela origem do contato. */
async function conversacionesPorFuente(
  organizationId: string,
  start: Date,
  end: Date
): Promise<Conteo[]> {
  return getDb()
    .select({
      key: effectiveSourceExpr(
        schema.conversation.organizationId,
        schema.conversation.contactId,
        schema.contact.source
      ),
      n: sql<number>`count(*)::int`,
    })
    .from(schema.conversation)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        gte(schema.conversation.createdAt, start),
        lt(schema.conversation.createdAt, end)
      )
    )
    .groupBy(sql`1`);
}

async function contarConversaciones(
  organizationId: string,
  start: Date,
  end: Date
): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        gte(schema.conversation.createdAt, start),
        lt(schema.conversation.createdAt, end)
      )
    );
  return rows[0]?.n ?? 0;
}

/** Prospectos criados no intervalo e quantos deles estão hoje em Ganho. */
async function prospectosPorFuente(
  organizationId: string,
  start: Date,
  end: Date
): Promise<ConteoLeads[]> {
  return getDb()
    .select({
      key: effectiveSourceExpr(
        schema.lead.organizationId,
        schema.lead.contactId,
        schema.contact.source
      ),
      leads: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${schema.pipelineStage.kind} = 'won')::int`,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.lead.contactId))
    .innerJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        gte(schema.lead.createdAt, start),
        lt(schema.lead.createdAt, end),
        notLabContact(schema.lead.contactId)
      )
    )
    .groupBy(sql`1`);
}

/** As linhas por anúncio: a chave é o `source_id`, ou a própria linha se não houver. */
const llave = sql<string>`coalesce(${schema.adAttribution.sourceId}, ${schema.adAttribution.id})`;
const metadatos = {
  sourceId: sql<string | null>`max(${schema.adAttribution.sourceId})`,
  sourceType: sql<string | null>`max(${schema.adAttribution.sourceType})`,
  headline: sql<string | null>`max(${schema.adAttribution.headline})`,
  imageAssetId: sql<string | null>`max(${schema.adAttribution.imageAssetId})`,
  lastAt: sql<number>`extract(epoch from max(${schema.adAttribution.createdAt}))::float`,
};

type Metadatos = {
  key: string;
  sourceId: string | null;
  sourceType: string | null;
  headline: string | null;
  imageAssetId: string | null;
  lastAt: number;
};

/**
 * Conversas reais que começaram no intervalo, pelo anúncio que as
 * abriu. Cada linha de `ad_attribution` é de UMA conversa (o primeiro
 * anúncio vence, 016), então não há contagem dupla.
 */
async function conversacionesPorAnuncio(
  organizationId: string,
  start: Date,
  end: Date
): Promise<(Metadatos & { conversations: number })[]> {
  return getDb()
    .select({
      key: llave,
      ...metadatos,
      conversations: sql<number>`count(*)::int`,
    })
    .from(schema.adAttribution)
    .innerJoin(
      schema.conversation,
      and(
        eq(schema.conversation.id, schema.adAttribution.conversationId),
        eq(schema.conversation.isTest, false)
      )
    )
    .where(
      scoped(
        schema.adAttribution.organizationId,
        organizationId,
        gte(schema.conversation.createdAt, start),
        lt(schema.conversation.createdAt, end)
      )
    )
    .groupBy(llave);
}

/**
 * Prospectos do período pelo anúncio que os trouxe, e quantos estão hoje em
 * Ganho.
 *
 * Cada contato conta UMA vez, com seu PRIMEIRO anúncio (o que mostra sua
 * ficha): juntar com todas as suas linhas o contaria duas vezes se escreveu desde
 * duas conversas.
 */
async function prospectosPorAnuncio(
  organizationId: string,
  start: Date,
  end: Date
): Promise<(Metadatos & { leads: number; won: number })[]> {
  return getDb()
    .select({
      key: llave,
      ...metadatos,
      leads: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${schema.pipelineStage.kind} = 'won')::int`,
    })
    .from(schema.lead)
    .innerJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .innerJoin(
      schema.adAttribution,
      and(
        eq(schema.adAttribution.organizationId, schema.lead.organizationId),
        eq(schema.adAttribution.contactId, schema.lead.contactId),
        sql`${schema.adAttribution.id} = ${firstAttributionIdExpr(
          schema.lead.organizationId,
          schema.lead.contactId
        )}`
      )
    )
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        gte(schema.lead.createdAt, start),
        lt(schema.lead.createdAt, end),
        notLabContact(schema.lead.contactId)
      )
    )
    .groupBy(llave);
}

/** As seis fontes na sua ordem fixa, só as que têm algo. */
export function unirFuentes(convs: Conteo[], leads: ConteoLeads[]): SourceRowDto[] {
  const conv = new Map(convs.map((c) => [c.key ?? "desconocida", c.n]));
  const lead = new Map(leads.map((l) => [l.key ?? "desconocida", l]));

  return FUENTES.map((value) => {
    const l = lead.get(value);
    const won = l?.won ?? 0;
    const leadsN = l?.leads ?? 0;
    return {
      value,
      label: SOURCE_LABELS[value],
      conversations: conv.get(value) ?? 0,
      leads: leadsN,
      won,
      winRate: rate(won, leadsN),
    };
  }).filter((f) => f.conversations > 0 || f.leads > 0);
}

/**
 * Une as duas visões por anúncio. Mais conversas primeiro; em empate, mais
 * prospectos, e depois o anúncio que trouxe alguém mais recentemente, que
 * é o que o dono está olhando.
 */
export function unirAnuncios(
  convs: (Metadatos & { conversations: number })[],
  leads: (Metadatos & { leads: number; won: number })[]
): AdRowDto[] {
  const filas = new Map<string, AdRowDto & { lastAt: number }>();
  const base = (m: Metadatos) => ({
    key: m.key,
    sourceId: m.sourceId,
    sourceType: m.sourceType,
    headline: m.headline,
    imageAssetId: m.imageAssetId,
    lastAt: m.lastAt,
    conversations: 0,
    leads: 0,
    won: 0,
    winRate: rate(0, 0),
  });

  for (const c of convs) {
    filas.set(c.key, { ...base(c), conversations: c.conversations });
  }
  for (const l of leads) {
    const fila = filas.get(l.key) ?? base(l);
    fila.leads = l.leads;
    fila.won = l.won;
    fila.winRate = rate(l.won, l.leads);
    // A imagem é baixada uma vez por anúncio e pode chegar depois: vale a que
    // houver, de qualquer uma das duas visões.
    fila.imageAssetId ??= l.imageAssetId;
    fila.headline ??= l.headline;
    if (l.lastAt > fila.lastAt) fila.lastAt = l.lastAt;
    filas.set(l.key, fila);
  }

  return [...filas.values()]
    .sort(
      (a, b) =>
        b.conversations - a.conversations ||
        b.leads - a.leads ||
        b.lastAt - a.lastAt
    )
    .slice(0, MAX_ANUNCIOS)
    .map(({ lastAt: _lastAt, ...fila }) => fila);
}
