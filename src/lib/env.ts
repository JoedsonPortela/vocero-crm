import { z } from "zod";

/**
 * Validação central do ambiente.
 *
 * Lazy + memoizada: é avaliada no primeiro uso em runtime, nunca ao importar.
 * Durante o `next build` não há segredos (a imagem é construída sem eles), então
 * nessa fase são aceitos placeholders — os valores reais chegam no boot.
 */

export const envSchema = z.object({
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message:
        "ENCRYPTION_KEY debe ser 32 bytes en base64 (genera con: openssl rand -base64 32)",
    }),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v25.0"),
  META_GRAPH_BASE_URL: z.string().url().default("https://graph.facebook.com"),
  OPENROUTER_API_TOKEN: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api"),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_JUDGE_MODEL: z.string().optional(),
  // 014/017: canais ligados, separados por vírgula. O WhatsApp está sempre ligado.
  // Ex.: CHANNELS=whatsapp,instagram,messenger. Sem ela, a instância é só
  // WhatsApp e as superfícies dos demais canais respondem 404.
  CHANNELS: z.string().optional(),
  // 015: motor de agenda. Desligado por padrão — sem ele, toda a superfície de
  // agenda responde 404 e a UI não a menciona. Ex.: AGENDA=on
  AGENDA: z.string().optional(),
  // 016: atribuição de anúncios e reporte à Conversions API da Meta.
  // Desligada por padrão: sem ela não se captura de qual anúncio veio uma
  // conversa, não se reporta nada à Meta e a superfície dá 404.
  // Ex.: ATRIBUCION=on
  ATRIBUCION: z.string().optional(),
  // 015: bases dos conectores. Só são sobrescritas para apontar para os
  // mocks no self-test; em produção usam-se as reais.
  ZOOM_BASE_URL: z.string().url().default("https://api.zoom.us/v2"),
  ZOOM_OAUTH_BASE_URL: z.string().url().default("https://zoom.us"),
  GOOGLE_CAL_BASE_URL: z
    .string()
    .url()
    .default("https://www.googleapis.com/calendar/v3"),
  GOOGLE_OAUTH_BASE_URL: z.string().url().default("https://oauth2.googleapis.com"),
  ALLOW_SIGNUP: z.string().optional(),
  AGENT_COALESCE_MS: z.coerce.number().int().min(0).default(6000),
  WA_MOCK_ENABLED: z.string().optional(),
  // API key de um cérebro externo que conduza a conversa por /api/bot/*.
  // Sem ela, toda essa superfície responde 401.
  BOT_API_KEY: z.string().optional(),
  // «Quem responde aos seus clientes»: o /health do cérebro externo (Nea),
  // consultado a partir do servidor. Ex.: http://nea:8000/health (alias da
  // rede do Coolify). Sem ela, o cartão do Agente não consulta ninguém.
  // Não é validado aqui de propósito: é opcional e só de diagnóstico, e com
  // `.url()` um valor mal escrito derrubava o CRM inteiro (o ambiente não
  // validava e tudo respondia 503). O cartão marca isso como problema de
  // configuração e o resto continua funcionando (server/bot/status.ts).
  BRAIN_HEALTH_URL: z.string().optional(),
  // 021: para onde o CRM despacha cada turno ao cérebro externo. Ex.:
  // http://nea:8000/vocero/dispatch. Com ela e `BOT_API_KEY`, o agente
  // incluído deixa de responder: responde o cérebro. Também não é validado aqui,
  // pelo mesmo motivo do de cima: mal escrita, o despacho fica inativo e
  // o cartão informa isso (server/brains/config.ts).
  BRAIN_DISPATCH_URL: z.string().optional(),
  // 008: volume local de anexos (constituição II: sem S3/R2).
  MEDIA_DIR: z.string().default("./.dev-media"),
  NODE_ENV: z.string().default("development"),
});

export type Env = z.infer<typeof envSchema>;

const BUILD_PLACEHOLDERS: Record<string, string> = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://build:build@localhost:5432/build",
  BETTER_AUTH_SECRET: "placeholder-build-secret",
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  META_WEBHOOK_VERIFY_TOKEN: "placeholder-verify-token",
};

let cached: Env | null = null;

/**
 * Valida um ambiente contra o esquema SEM lançar nem armazenar em cache. É o que usa
 * `getEnv()` e também o `pnpm doctor` (scripts/doctor.ts): um só esquema e
 * uma só regra para as strings vazias, que contam como ausentes porque
 * os compose/painéis costumam injetar VAR="" para os opcionais e isso deve
 * ativar os padrões.
 */
export function safeParseEnv(source: Record<string, string | undefined>) {
  return envSchema.safeParse(stripEmpty(source));
}

export function getEnv(): Env {
  if (cached) return cached;
  const isBuild = process.env.NEXT_PHASE === "phase-production-build";
  const source = isBuild
    ? { ...BUILD_PLACEHOLDERS, ...stripEmpty(process.env) }
    : process.env;
  const parsed = safeParseEnv(source);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(
      `Variables de entorno inválidas o faltantes:\n  ${missing}\n` +
        "Revisa .env.example para la guía de cada variable."
    );
  }
  cached = parsed.data;
  return cached;
}

function stripEmpty(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/** true se o ambiente de testes interno (mocks) está habilitado e NÃO é produção. */
export function isMockEnabled(): boolean {
  return (
    process.env.WA_MOCK_ENABLED === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * true se o AMBIENTE traz provedor de IA (`OPENROUTER_API_TOKEN` presente e
 * não vazio). É só a reserva: o que decide se uma organização tem IA
 * é `isAiConfiguredFor()` em `lib/ai/provider.ts`, que olha primeiro o
 * salvo em Ajustes → IA.
 */
export function isAiConfiguredByEnv(): boolean {
  const token = process.env.OPENROUTER_API_TOKEN;
  return typeof token === "string" && token.trim().length > 0;
}
