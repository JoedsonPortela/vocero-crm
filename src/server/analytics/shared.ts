import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * 019 — Trechos de SQL que compartilham os quatro blocos de Resultados.
 *
 * São subconsultas CORRELACIONADAS com a coluna que recebem. Vão em WHERE, em
 * condições de JOIN ou em consultas com JOIN: na lista de SELECT de uma
 * consulta de uma só tabela, o drizzle tira a tabela da coluna
 * interpolada e a subconsulta se correlacionaria consigo mesma (ver
 * `conversacionId` em bot.ts).
 */

/**
 * O Laboratório NÃO existe para a analítica (spec 019, D6).
 *
 * Suas execuções geram conversas completas com respostas do modelo e
 * escalonamentos; sem este filtro, uma tarde de autotestes inflaria
 * conversas, taxa de resposta e tempos, e o dono tomaria decisões
 * sobre pessoas que não existem.
 *
 * Exclui-se o contato cuja ÚNICA conversa é de teste. Um contato real
 * que tenha também uma conversa de laboratório continua contando: o real pesa
 * mais que o simulado.
 */
export function notLabContact(contactIdColumn: PgColumn): SQL {
  return sql`(
    not exists (
      select 1 from "conversation" lab
      where lab."contact_id" = ${contactIdColumn} and lab."is_test" = true
    )
    or exists (
      select 1 from "conversation" real_conv
      where real_conv."contact_id" = ${contactIdColumn} and real_conv."is_test" = false
    )
  )`;
}

/**
 * Data local do negócio para agrupar séries. As colunas são `timestamp`
 * sem fuso e guardam UTC: o primeiro `AT TIME ZONE` as interpreta como UTC e
 * o segundo as leva para a hora do negócio.
 */
export function localDateExpr(
  column: PgColumn,
  timezone: string,
  byMonth: boolean
): SQL<string> {
  const format = byMonth ? "YYYY-MM" : "YYYY-MM-DD";
  return sql<string>`to_char((${column} at time zone 'UTC' at time zone ${timezone}), ${format})`;
}

/**
 * A origem EFETIVA do contato, em SQL: a capturada prevalece; sem captura,
 * «anúncio» se o seu PRIMEIRO anúncio de origem for um anúncio (não uma publicação);
 * senão NULL (= não identificada).
 *
 * É a mesma regra da ficha do contato (018: a primeira linha de
 * `ad_attribution` + `cuentaComoAnuncio` + `effectiveSource`): se Resultados
 * deduzisse de outro jeito, a tabela por origem contradiria o que o dono vê na
 * ficha.
 */
export function effectiveSourceExpr(
  organizationIdColumn: PgColumn,
  contactIdColumn: PgColumn,
  sourceColumn: PgColumn
): SQL<string | null> {
  return sql<string | null>`coalesce(${sourceColumn}, (
    select case when coalesce(primero."source_type", 'ad') = 'post' then null else 'anuncio' end
    from "ad_attribution" primero
    where primero."organization_id" = ${organizationIdColumn}
      and primero."contact_id" = ${contactIdColumn}
    order by primero."created_at" asc, primero."id" asc
    limit 1
  ))`;
}

/**
 * A primeira linha de `ad_attribution` do contato, a mesma que mostra sua
 * ficha: um contato conta UMA vez, com o anúncio que o trouxe primeiro.
 */
export function firstAttributionIdExpr(
  organizationIdColumn: PgColumn,
  contactIdColumn: PgColumn
): SQL<string | null> {
  return sql<string | null>`(
    select primero."id" from "ad_attribution" primero
    where primero."organization_id" = ${organizationIdColumn}
      and primero."contact_id" = ${contactIdColumn}
    order by primero."created_at" asc, primero."id" asc
    limit 1
  )`;
}
