import path from "node:path";
import postgres from "postgres";
import type { ZodIssue } from "zod";
import { getDb, PG_CONNECTION_OPTIONS, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { envSchema, safeParseEnv, type Env } from "@/lib/env";
import { leerConfigDespacho } from "@/server/brains/config";
import { GENERATED_SECRETS, PLACEHOLDER_PREFIX } from "@/server/doctor/init-env";
import { probeMediaDir } from "@/server/media-dir";
import { testConnection, type ConnectionCheck } from "@/server/whatsapp/connect";
import {
  getCredentialsByOrg,
  tokenLast4,
  type Credentials,
} from "@/server/whatsapp/credentials";

/**
 * `pnpm doctor` — as verificações, uma por linha, com o conserto exato de
 * cada ✗. Nada aqui imprime: devolve resultados e o CLI (scripts/doctor.ts)
 * os formata. O que toca rede ou disco recebe sua sonda por parâmetro para
 * poder ser testado sem Postgres nem Meta.
 *
 * Regra da casa (constituição I): jamais um segredo na saída. Das
 * variáveis secretas só se diz que estão definidas e quanto medem; da
 * URL do banco, tudo menos a senha; do token do WhatsApp, os
 * últimos 4 caracteres, como na UI.
 */

export type CheckStatus = "ok" | "fail" | "warn" | "skip";

export type CheckResult = {
  status: CheckStatus;
  label: string;
  detail?: string;
  /** Comando ou ação exata para consertar (em todo ✗ e nos avisos). */
  fix?: string;
};

/* ---------- Variáveis de ambiente ---------- */

/**
 * As variáveis que a inicialização exige: as do esquema sem default nem
 * `.optional()`. Derivadas do esquema, não copiadas: se o env.ts ganhar uma
 * obrigatória, o doctor a verifica sozinho.
 */
export function requiredEnvKeys(): string[] {
  return Object.entries(envSchema.shape)
    .filter(([, type]) => !type.isOptional())
    .map(([key]) => key);
}

/** Variáveis cujo valor nunca é impresso (nem inteiro nem em parte). */
const SECRET_KEYS = new Set<string>([
  ...Object.keys(GENERATED_SECRETS),
  "DATABASE_URL",
  "OPENROUTER_API_TOKEN",
  "META_APP_SECRET",
  "BOT_API_KEY",
]);

const FIX: Record<string, string> = {
  APP_BASE_URL:
    "en .env: APP_BASE_URL=https://crm.tudominio.com (con docker compose en esta máquina: https://localhost)",
  DATABASE_URL:
    "en .env: DATABASE_URL=postgresql://postgres:<POSTGRES_PASSWORD>@postgres:5432/vocero (docker compose) o ...@localhost:5432/vocero (docker-compose.dev.yml)",
  DOMAIN:
    "en .env: DOMAIN=crm.tudominio.com (o localhost para probar aquí); solo lo usa docker compose para el HTTPS de Caddy",
};

export function fixFor(key: string): string {
  if (key in GENERATED_SECRETS) {
    const { openssl } = GENERATED_SECRETS[key as keyof typeof GENERATED_SECRETS];
    const extra = key === "POSTGRES_PASSWORD" ? " (la misma dentro de DATABASE_URL)" : "";
    return `genera uno nuevo con: ${openssl}  y pégalo en .env${extra}; sin .env todavía, pnpm init-env los genera todos`;
  }
  return FIX[key] ?? "revisa la guía de esa variable en .env.example";
}

/** `postgresql://usuario:***@host:puerto/base` — tudo menos a senha. */
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username || "?"}:***@${u.host}${u.pathname}`;
  } catch {
    return "(no se pudo interpretar como URL)";
  }
}

export function describeValue(key: string, value: string): string {
  if (key === "DATABASE_URL") return redactDatabaseUrl(value);
  if (SECRET_KEYS.has(key)) return `definida (${value.length} caracteres)`;
  return value;
}

/** A mensagem do zod em português e sem o valor (o zod não o inclui, mas por via das dúvidas). */
export function translateIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? "falta"
        : `tipo inválido (se esperaba ${issue.expected})`;
    case "invalid_string":
      return issue.validation === "url"
        ? "no es una URL válida (debe empezar por http:// o https://)"
        : issue.message;
    case "too_small":
      return `demasiado corta: mínimo ${issue.minimum} caracteres`;
    default:
      return issue.message;
  }
}

function hasPlaceholder(value: string | undefined): value is string {
  return typeof value === "string" && value.includes(PLACEHOLDER_PREFIX);
}

function checkVar(
  key: string,
  value: string | undefined,
  issue: ZodIssue | undefined,
  required: boolean
): CheckResult {
  if (hasPlaceholder(value)) {
    return {
      status: "fail",
      label: key,
      detail: `sigue con el valor de ejemplo (${PLACEHOLDER_PREFIX}…)`,
      fix: fixFor(key),
    };
  }
  if (issue) {
    return { status: "fail", label: key, detail: translateIssue(issue), fix: fixFor(key) };
  }
  const present = typeof value === "string" && value !== "";
  if (!present) {
    return required
      ? { status: "fail", label: key, detail: "falta", fix: fixFor(key) }
      : { status: "skip", label: key, detail: "no definida (opcional)" };
  }
  return { status: "ok", label: key, detail: describeValue(key, value) };
}

export type EnvEvaluation = { results: CheckResult[]; env: Env | null };

/**
 * Passa o ambiente pelo MESMO esquema da inicialização (safeParseEnv) e
 * devolve uma linha por variável obrigatória, mais uma por cada opcional que
 * tenha um problema (também derrubam a inicialização) ou continue com seu placeholder.
 */
export function evaluateEnv(source: Record<string, string | undefined>): EnvEvaluation {
  const parsed = safeParseEnv(source);
  const issues = new Map<string, ZodIssue>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !issues.has(key)) issues.set(key, issue);
    }
  }

  const results: CheckResult[] = [];
  const seen = new Set<string>();
  for (const key of requiredEnvKeys()) {
    seen.add(key);
    results.push(checkVar(key, source[key], issues.get(key), true));
  }
  for (const [key, issue] of issues) {
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(checkVar(key, source[key], issue, false));
  }
  for (const [key, value] of Object.entries(source)) {
    if (seen.has(key) || !hasPlaceholder(value)) continue;
    if ((COMPOSE_ONLY_KEYS as readonly string[]).includes(key)) continue; // listadas por evaluateComposeEnv
    seen.add(key);
    results.push(checkVar(key, value, undefined, false));
  }
  return { results, env: parsed.success ? parsed.data : null };
}

/** Variáveis que o app não lê, mas o docker-compose.yml sim (Rota B). */
export const COMPOSE_ONLY_KEYS = ["DOMAIN", "POSTGRES_PASSWORD"] as const;

export function evaluateComposeEnv(source: Record<string, string | undefined>): CheckResult[] {
  const results: CheckResult[] = [];
  for (const key of COMPOSE_ONLY_KEYS) {
    const value = source[key];
    if (hasPlaceholder(value)) {
      results.push(checkVar(key, value, undefined, true));
    } else if (typeof value === "string" && value !== "") {
      results.push({ status: "ok", label: key, detail: describeValue(key, value) });
    } else {
      results.push({
        status: "skip",
        label: key,
        detail: "no definida: solo la usa docker compose (Ruta B)",
        fix: fixFor(key),
      });
    }
  }

  // O docker compose monta a DATABASE_URL do app com POSTGRES_PASSWORD; a
  // do .env só é lida pelo pnpm dev e por este doctor. Se não coincidirem, o que se
  // testa aqui não é o que vai rodar no contêiner.
  const password = source.POSTGRES_PASSWORD;
  const url = source.DATABASE_URL;
  if (password && url && !hasPlaceholder(password) && !hasPlaceholder(url)) {
    try {
      const u = new URL(url);
      if (u.hostname === "postgres" && decodeURIComponent(u.password) !== password) {
        results.push({
          status: "warn",
          label: "POSTGRES_PASSWORD",
          detail: "no es la contraseña que lleva DATABASE_URL",
          fix: "deja la misma en las dos: docker compose usa POSTGRES_PASSWORD para la base y para la app; DATABASE_URL de .env solo la leen pnpm dev y pnpm doctor",
        });
      }
    } catch {
      // a URL inválida já saiu como ✗ no evaluateEnv
    }
  }
  return results;
}

/* ---------- Banco de dados ---------- */

export type DbProbe = (url: string) => Promise<void>;

/** Um `select 1` com as mesmas opções de conexão do app. */
export const probeDatabase: DbProbe = async (url) => {
  const sql = postgres(url, { max: 1, connect_timeout: 5, ...PG_CONNECTION_OPTIONS });
  try {
    await sql`select 1`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
};

export async function checkDatabase(
  url: string,
  probe: DbProbe = probeDatabase
): Promise<CheckResult> {
  const started = Date.now();
  try {
    await probe(url);
    return {
      status: "ok",
      label: "DATABASE_URL",
      detail: `select 1 respondió en ${Date.now() - started} ms (${redactDatabaseUrl(url)})`,
    };
  } catch (err) {
    return describeDbError(err, url);
  }
}

export function describeDbError(err: unknown, url: string): CheckResult {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  const message = err instanceof Error ? err.message : String(err);
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {}
  const where = redactDatabaseUrl(url);
  const label = "DATABASE_URL";

  if ((code === "ENOTFOUND" || code === "EAI_AGAIN") && hostname === "postgres") {
    return {
      status: "skip",
      label,
      detail: `el host "postgres" solo existe dentro de la red de docker compose: desde aquí no se puede probar (${where})`,
      fix: "arranca con docker compose up -d y comprueba docker compose ps y docker compose logs app: la app valida la conexión al arrancar y /api/health responde ok cuando la base contesta",
    };
  }
  switch (code) {
    case "ECONNREFUSED":
      return {
        status: "fail",
        label,
        detail: `nada escucha en ${where}`,
        fix: "arranca Postgres: docker compose -f docker-compose.dev.yml up -d (desarrollo local) o docker compose up -d postgres (Ruta B), o corrige host y puerto en DATABASE_URL",
      };
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return {
        status: "fail",
        label,
        detail: `el host no resuelve (${where})`,
        fix: "corrige el host de DATABASE_URL: localhost con docker-compose.dev.yml, postgres dentro de docker compose",
      };
    case "CONNECT_TIMEOUT":
      return {
        status: "fail",
        label,
        detail: `no respondió en 5 s (${where})`,
        fix: "revisa que Postgres esté arriba y que el puerto sea alcanzable desde esta máquina",
      };
    case "28P01":
    case "28000":
      return {
        status: "fail",
        label,
        detail: `usuario o contraseña rechazados (${where})`,
        fix: "la contraseña de DATABASE_URL debe ser la de Postgres (en docker compose, POSTGRES_PASSWORD); si cambiaste la contraseña después del primer arranque, Postgres conserva la vieja en su volumen",
      };
    case "3D000":
      return {
        status: "fail",
        label,
        detail: `la base de datos no existe (${where})`,
        fix: "créala (CREATE DATABASE vocero) o deja que docker compose la cree con POSTGRES_DB=vocero",
      };
    default:
      return {
        status: "fail",
        label,
        detail: `${message} (${where})`,
        fix: "revisa DATABASE_URL en .env y que Postgres esté arriba",
      };
  }
}

/* ---------- Anexos ---------- */

/**
 * A mesma sondagem que fazem a inicialização e o `/api/health` (`mediaWritable`,
 * #82): escrever de verdade e apagar o rastro. Sem cache: aqui se quer a
 * resposta de agora.
 */
export async function checkMediaDir(dir: string): Promise<CheckResult> {
  const media = await probeMediaDir(path.resolve(dir));
  if (media.writable) {
    return { status: "ok", label: "MEDIA_DIR", detail: `${media.dir} es escribible` };
  }
  return {
    status: "fail",
    label: "MEDIA_DIR",
    detail: `${media.dir} no es escribible (${media.code}): adjuntos, logo e icono no se podrían guardar`,
    fix: "fuera de Docker: apunta MEDIA_DIR a un directorio escribible (o quítala: el default es ./.dev-media). En Docker no la definas: la imagen usa /data/media y docker compose monta el volumen en /data",
  };
}

/* ---------- WhatsApp (Meta) ---------- */

export type StoredWhatsApp = {
  organization: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  /** null = a linha existe mas não foi possível descriptografar com a ENCRYPTION_KEY atual. */
  credentials: Credentials | null;
};

/**
 * As conexões guardadas, organização por organização e pela mesma
 * porta que usa o app (getCredentialsByOrg: consulta limitada + descriptografia).
 * A raiz do Vocero não tem credenciais de WhatsApp no ambiente: elas vivem criptografadas
 * no banco.
 */
export async function loadWhatsAppCredentials(): Promise<StoredWhatsApp[]> {
  const db = getDb();
  const orgs = await db
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization);
  const out: StoredWhatsApp[] = [];
  for (const org of orgs) {
    try {
      const credentials = await getCredentialsByOrg(org.id);
      if (!credentials) continue;
      out.push({
        organization: org.name,
        phoneNumberId: credentials.phoneNumberId,
        displayPhoneNumber: credentials.displayPhoneNumber,
        credentials,
      });
    } catch (err) {
      // A linha existe, mas o token não descriptografa: ENCRYPTION_KEY diferente.
      // Qualquer outro erro (tabela ausente, BD fora do ar) sobe, sim.
      if (!isDecryptError(err)) throw err;
      const rows = await db
        .select({
          phoneNumberId: schema.metaCredentials.phoneNumberId,
          displayPhoneNumber: schema.metaCredentials.displayPhoneNumber,
        })
        .from(schema.metaCredentials)
        .where(scoped(schema.metaCredentials.organizationId, org.id))
        .limit(1);
      const row = rows[0];
      if (row) {
        out.push({ organization: org.name, ...row, credentials: null });
      }
    }
  }
  return out;
}

function isDecryptError(err: unknown): boolean {
  // GCM com outra chave: "Unsupported state or unable to authenticate data".
  const message = err instanceof Error ? err.message : "";
  return /unable to authenticate|unsupported state|ENCRYPTION_KEY/i.test(message);
}

export type WhatsAppDeps = {
  load?: () => Promise<StoredWhatsApp[]>;
  test?: (phoneNumberId: string, token: string) => Promise<ConnectionCheck>;
};

/**
 * Uma chamada de teste à Meta por conexão guardada, com o mesmo
 * testConnection do assistente (GET do número com o token). Sem conexão
 * guardada não é uma falha: o WhatsApp se conecta pelo app.
 */
export async function checkWhatsApp(deps: WhatsAppDeps = {}): Promise<CheckResult[]> {
  const load = deps.load ?? loadWhatsAppCredentials;
  const test = deps.test ?? testConnection;

  let stored: StoredWhatsApp[];
  try {
    stored = await load();
  } catch (err) {
    const code = String((err as { code?: unknown } | null)?.code ?? "");
    if (code === "42P01") {
      return [
        {
          status: "skip",
          label: "WhatsApp",
          detail: "las tablas no existen todavía: las migraciones corren al arrancar la app",
          fix: "docker compose up -d (o pnpm db:migrate en desarrollo) y vuelve a correr pnpm doctor",
        },
      ];
    }
    return [
      {
        status: "warn",
        label: "WhatsApp",
        detail: `no se pudieron leer las conexiones guardadas: ${err instanceof Error ? err.message : String(err)}`,
        fix: "revisa la conexión a la base de datos",
      },
    ];
  }

  if (stored.length === 0) {
    return [
      {
        status: "skip",
        label: "WhatsApp",
        detail: "sin conexión guardada: se conecta desde la app (Configuración → WhatsApp), no es parte de la instalación",
      },
    ];
  }

  const results: CheckResult[] = [];
  for (const item of stored) {
    const label = `WhatsApp ${item.displayPhoneNumber ?? item.phoneNumberId} (${item.organization})`;
    if (!item.credentials) {
      results.push({
        status: "fail",
        label,
        detail: "el token guardado no se pudo descifrar: la ENCRYPTION_KEY no es la misma con la que se guardó",
        fix: "restaura la ENCRYPTION_KEY original o vuelve a pegar el token en Configuración → WhatsApp",
      });
      continue;
    }
    const { token, phoneNumberId } = item.credentials;
    let check: ConnectionCheck;
    try {
      check = await test(phoneNumberId, token);
    } catch (err) {
      results.push({
        status: "warn",
        label,
        detail: `la prueba contra Meta falló: ${err instanceof Error ? err.message : String(err)}`,
        fix: "reintenta en unos minutos",
      });
      continue;
    }
    if (check.ok) {
      const name = check.verifiedName ? ` (${check.verifiedName})` : "";
      results.push({
        status: "ok",
        label,
        detail: `Meta respondió ${check.displayPhoneNumber}${name} · token …${tokenLast4(token)}`,
      });
    } else if (check.code === "invalid_token") {
      results.push({
        status: "fail",
        label,
        detail: `${check.message} (token …${tokenLast4(token)})`,
        fix: "Configuración → WhatsApp: pega un token vigente (modo directo: token de usuario del sistema, que no expira)",
      });
    } else if (check.code === "meta_unavailable") {
      results.push({ status: "warn", label, detail: check.message, fix: "reintenta en unos minutos" });
    } else {
      results.push({
        status: "fail",
        label,
        detail: check.message,
        fix: "revisa el Phone Number ID y el token en Configuración → WhatsApp",
      });
    }
  }
  return results;
}

/* ---------- IA (opcional) ---------- */

export function checkAi(env: Env): CheckResult {
  if (!env.OPENROUTER_API_TOKEN) {
    return {
      status: "skip",
      label: "OPENROUTER_API_TOKEN",
      detail: "no definida: el CRM funciona completo salvo el agente y el Laboratorio",
      fix: "para activarlos, OPENROUTER_API_TOKEN y OPENROUTER_MODEL en .env (guía en .env.example)",
    };
  }
  if (!env.OPENROUTER_MODEL) {
    return {
      status: "warn",
      label: "OPENROUTER_API_TOKEN",
      detail: "definida, pero sin OPENROUTER_MODEL el agente no sabe qué modelo pedir",
      fix: "en .env: OPENROUTER_MODEL=anthropic/claude-sonnet-4.5 (u otro de openrouter.ai/models)",
    };
  }
  const judge = env.OPENROUTER_JUDGE_MODEL ? ` · juez ${env.OPENROUTER_JUDGE_MODEL}` : "";
  return {
    status: "ok",
    label: "OPENROUTER_API_TOKEN",
    detail: `definida · modelo ${env.OPENROUTER_MODEL}${judge}`,
  };
}

/* ---------- Despacho ao cérebro (opcional) ---------- */

/**
 * 021 — `BRAIN_DISPATCH_URL` mal colocada não derruba nada: o despacho fica
 * inativo e responde o agente incluído, como na 1.5. Por isso é um aviso e não
 * um ✗: é justamente o caso que alguém procura quando «o cérebro não recebe
 * nada». Nunca se imprime a URL inteira (pode levar rota com segredo).
 */
export function checkDispatch(
  source: Record<string, string | undefined>
): CheckResult {
  const config = leerConfigDespacho(source);
  const label = "BRAIN_DISPATCH_URL";
  if (config.active) {
    return {
      status: "ok",
      label,
      detail: `el CRM le despacha cada turno a ${config.host}, firmado con BOT_API_KEY; el agente incluido queda en silencio`,
    };
  }
  if (config.problem === "url") {
    return {
      status: "warn",
      label,
      detail: "no es una URL http:// o https:// válida (o lleva usuario:clave): el despacho queda INACTIVO",
      fix: "en .env: BRAIN_DISPATCH_URL=http://nea:8000/vocero/dispatch (la dirección interna de tu cerebro)",
    };
  }
  if (config.problem === "sin_llave") {
    return {
      status: "warn",
      label,
      detail: `apunta a ${config.host}, pero falta BOT_API_KEY (mínimo 16 caracteres): el despacho queda INACTIVO`,
      fix: "en .env: BOT_API_KEY=$(openssl rand -base64 32), y la misma llave en tu cerebro",
    };
  }
  return {
    status: "skip",
    label,
    detail: "no definida: contesta el agente incluido, o un cerebro que reciba el webhook por su cuenta",
  };
}

/* ---------- Saída ---------- */

const MARK: Record<CheckStatus, string> = { ok: "✓", fail: "✗", warn: "!", skip: "-" };

export function formatResult(r: CheckResult): string {
  const head = `${MARK[r.status]} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`;
  return r.fix && r.status !== "ok" ? `${head}\n    → ${r.fix}` : head;
}

export function summarize(results: CheckResult[]) {
  const count = (status: CheckStatus) => results.filter((r) => r.status === status).length;
  const fail = count("fail");
  return { ok: count("ok"), fail, warn: count("warn"), skip: count("skip"), exitCode: fail > 0 ? 1 : 0 };
}
