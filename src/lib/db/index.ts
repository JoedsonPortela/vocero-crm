import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Opções de conexão comuns a TODA conexão que abra este repositório (app, seeds,
 * migrações, arneses E2E).
 *
 * `TimeZone: "UTC"` não é cosmético, é o invariante de tempo do projeto.
 * As colunas são `timestamp without time zone`, e o Drizzle as trata sempre
 * como UTC nas duas direções: ao ler faz `new Date(valor + "+0000")` e ao
 * escrever faz `valor.toISOString()`. O único escritor que sai desse marco é
 * SQL: o `now()` dos `defaultNow()` é convertido para `timestamp` usando
 * a zona da SESSÃO, então num Postgres que não roda em UTC escreve
 * hora LOCAL, e esse mesmo valor é lido de novo como se fosse UTC.
 *
 * Sintoma real (Postgres em UTC-6): uma mensagem enviada aparecia como 08:59 na bolha
 * do fio (`message.created_at`, escrito por `now()`) e 14:59 na lista
 * (`conversation.last_message_at`, escrito pelo JS). Fixar a zona da sessão
 * em UTC alinha o `now()` com o Drizzle e, com isso, TODAS as colunas
 * `defaultNow()` do esquema de uma vez, sem migração e sem depender de como
 * está configurado o servidor do BD. No Docker os contêineres já rodam em
 * UTC — isto faz com que o dev local e qualquer Postgres self-hosted se
 * comportem igual.
 */
export const PG_CONNECTION_OPTIONS = {
  onnotice: () => {},
  connection: { TimeZone: "UTC" },
} as const;

/**
 * Cliente de BD único por processo. No dev, o Next recarrega módulos: é armazenado em cache
 * em globalThis para não esgotar conexões.
 */
const globalForDb = globalThis as unknown as {
  __voceroSql?: ReturnType<typeof postgres>;
};

function createClient() {
  const env = getEnv();
  return postgres(env.DATABASE_URL, {
    max: 10,
    ...PG_CONNECTION_OPTIONS,
  });
}

export function getSql() {
  if (!globalForDb.__voceroSql) globalForDb.__voceroSql = createClient();
  return globalForDb.__voceroSql;
}

let cachedDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!cachedDb) cachedDb = drizzle(getSql(), { schema });
  return cachedDb;
}

export { schema };
