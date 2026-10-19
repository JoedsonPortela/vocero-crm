import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * `pnpm init-env` — cria `.env` a partir de `.env.example` com os segredos
 * já gerados, para que `docker compose up -d` inicie sem editar nada.
 *
 * A lógica é pura (texto → texto) de propósito: testa-se sem tocar no
 * disco, e o CLI (scripts/init-env.ts) só decide se pode escrever. Os
 * comentários do exemplo são mantidos: o `.env` resultante continua sendo o
 * guia inline de cada variável.
 */

/** Prefixo dos valores de exemplo que devem ser substituídos. */
export const PLACEHOLDER_PREFIX = "REEMPLAZA_";

/** Domínio padrão: o Caddyfile o serve com certificado interno. */
export const DEFAULT_DOMAIN = "localhost";

/**
 * Os segredos que a inicialização exige (src/lib/env.ts) mais a senha de
 * Postgres do compose. O comando `openssl` é o que pedia a documentação:
 * o `pnpm doctor` o sugere quando falta um num `.env` que já existe.
 */
export const GENERATED_SECRETS = {
  POSTGRES_PASSWORD: {
    generate: () => randomBytes(24).toString("hex"),
    openssl: "openssl rand -hex 24",
  },
  BETTER_AUTH_SECRET: {
    generate: () => randomBytes(32).toString("base64"),
    openssl: "openssl rand -base64 32",
  },
  // Exatamente 32 bytes: é o que valida o esquema (AES-256-GCM).
  ENCRYPTION_KEY: {
    generate: () => randomBytes(32).toString("base64"),
    openssl: "openssl rand -base64 32",
  },
  META_WEBHOOK_VERIFY_TOKEN: {
    generate: () => randomBytes(32).toString("hex"),
    openssl: "openssl rand -hex 32",
  },
} as const;

export type GeneratedSecret = keyof typeof GENERATED_SECRETS;

export function generateSecrets(): Record<GeneratedSecret, string> {
  const out = {} as Record<GeneratedSecret, string>;
  for (const key of Object.keys(GENERATED_SECRETS) as GeneratedSecret[]) {
    out[key] = GENERATED_SECRETS[key].generate();
  }
  return out;
}

/** Um domínio sem esquema nem rota: o que o Caddy põe no seu site address. */
export function isValidDomain(domain: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain);
}

export type RenderedEnv = {
  content: string;
  /** Variáveis cujo valor foi gerado (só nomes: os valores não são impressos). */
  generated: string[];
  /** Variáveis fixadas em um valor não secreto (DOMAIN, APP_BASE_URL). */
  set: Record<string, string>;
  /** Variáveis ativas que continuam com REEMPLAZA_ (hoje nenhuma; por via das dúvidas, se o exemplo crescer). */
  pending: string[];
};

/**
 * Transforma o texto de `.env.example` no de um `.env` pronto para
 * iniciar. Linha a linha: só mudam as variáveis ativas (sem `#`) que
 * precisam ser geradas ou fixadas; comentários e todo o resto ficam iguais.
 */
export function renderInitEnv(
  example: string,
  opts: { domain?: string; secrets?: Record<GeneratedSecret, string> } = {}
): RenderedEnv {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  const secrets = opts.secrets ?? generateSecrets();
  const set: Record<string, string> = {
    DOMAIN: domain,
    APP_BASE_URL: `https://${domain}`,
  };
  const generated: string[] = [];
  const pending: string[] = [];
  const eol = example.includes("\r\n") ? "\r\n" : "\n";

  const lines = example.split(/\r?\n/).map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1] as string;
    const value = match[2] as string;

    if (key in secrets) {
      generated.push(key);
      return `${key}=${secrets[key as GeneratedSecret]}`;
    }
    if (key in set) return `${key}=${set[key]}`;
    if (key === "DATABASE_URL") {
      // postgresql://usuario:REEMPLAZA_...@host:puerto/base → a mesma
      // senha que acaba de receber POSTGRES_PASSWORD.
      const url = /^(\w+:\/\/[^:/@]+:)REEMPLAZA_[^@]*(@.*)$/.exec(value);
      if (url) {
        generated.push(key);
        return `${key}=${url[1]}${secrets.POSTGRES_PASSWORD}${url[2]}`;
      }
    }
    if (value.includes(PLACEHOLDER_PREFIX)) pending.push(key);
    return line;
  });

  return { content: lines.join(eol), generated, set, pending };
}

export type InitEnvIo = {
  exists: (file: string) => Promise<boolean>;
  read: (file: string) => Promise<string>;
  /** Deve falhar se o arquivo já existir (flag "wx"): a verificação prévia não basta sozinha. */
  writeNew: (file: string, content: string) => Promise<void>;
};

const defaultIo: InitEnvIo = {
  exists: (file) =>
    access(file).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return false;
        throw err;
      }
    ),
  read: (file) => readFile(file, "utf8"),
  // 0600: o arquivo leva segredos. flag wx: nunca sobrescreve um existente.
  writeNew: (file, content) => writeFile(file, content, { mode: 0o600, flag: "wx" }),
};

export type InitEnvOutcome =
  | { status: "created"; rendered: RenderedEnv; envPath: string }
  | { status: "exists"; envPath: string }
  | { status: "no_example"; examplePath: string }
  | { status: "bad_domain"; domain: string };

/**
 * Decide e executa: cria `<dir>/.env` a partir de `<dir>/.env.example`. Nunca sobrescreve
 * um `.env` existente (quem já o tem colocou ali seus segredos reais).
 */
export async function runInitEnv(
  opts: { dir: string; domain?: string; io?: InitEnvIo }
): Promise<InitEnvOutcome> {
  const io = opts.io ?? defaultIo;
  const envPath = path.join(opts.dir, ".env");
  const examplePath = path.join(opts.dir, ".env.example");
  const domain = opts.domain ?? DEFAULT_DOMAIN;

  if (!isValidDomain(domain)) return { status: "bad_domain", domain };
  if (await io.exists(envPath)) return { status: "exists", envPath };
  if (!(await io.exists(examplePath))) return { status: "no_example", examplePath };

  const rendered = renderInitEnv(await io.read(examplePath), { domain });
  try {
    await io.writeNew(envPath, rendered.content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { status: "exists", envPath };
    }
    throw err;
  }
  return { status: "created", rendered, envPath };
}
