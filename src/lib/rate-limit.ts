/**
 * Limitação de taxa in-process por chave (IP) com janela deslizante
 * (FR-062). Suficiente para o monolito de uma instância; sem Redis
 * (Constituição II).
 */

type Bucket = {
  /** timestamps (ms) das tentativas */
  hits: number[];
  /** a janela com a qual foi preenchido: a varredura precisa dela */
  windowMs: number;
};

const globalForRl = globalThis as unknown as {
  __voceroRateLimit?: Map<string, Bucket>;
};

function store(): Map<string, Bucket> {
  if (!globalForRl.__voceroRateLimit) {
    globalForRl.__voceroRateLimit = new Map();
  }
  return globalForRl.__voceroRateLimit;
}

/**
 * As chaves são por IP em superfícies públicas (login, `/api/bot/*`): quem
 * troca de IP — ou falsifica `x-forwarded-for` se o app ficar sem proxy — estreia uma
 * chave por request. Sem varredura, o mapa cresceria para sempre; com ela, a
 * memória fica limitada pelo tráfego da última janela.
 */
const SWEEP_AT = 10_000;
let lastSweep = 0;

function sweep(buckets: Map<string, Bucket>, now: number): void {
  if (buckets.size < SWEEP_AT || now - lastSweep < 1000) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    const last = b.hits[b.hits.length - 1] ?? 0;
    if (last <= now - b.windowMs) buckets.delete(key);
  }
}

export type RateLimitResult = { allowed: boolean; remaining: number };

export function checkRateLimit(
  key: string,
  opts: { windowMs: number; max: number },
  now: number = Date.now()
): RateLimitResult {
  const buckets = store();
  sweep(buckets, now);
  const cutoff = now - opts.windowMs;
  const hits = (buckets.get(key)?.hits ?? []).filter((t) => t > cutoff);

  if (hits.length >= opts.max) {
    buckets.set(key, { hits, windowMs: opts.windowMs });
    return { allowed: false, remaining: 0 };
  }
  hits.push(now);
  buckets.set(key, { hits, windowMs: opts.windowMs });
  return { allowed: true, remaining: opts.max - hits.length };
}

/**
 * O IP do cliente para LIMITAR, jamais para autorizar: o primeiro salto de
 * `x-forwarded-for` (atrás do Traefik/Coolify ou Caddy é o cliente real),
 * depois `x-real-ip`, e "local" sem proxy. Sem proxy na frente, o cliente
 * pode falsificá-lo: por isso só decide a quem frear.
 */
export function clientIp(headers: Headers | null | undefined): string {
  return (
    headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers?.get("x-real-ip") ||
    "local"
  );
}

/** Somente para testes. */
export function resetRateLimit(): void {
  store().clear();
  lastSweep = 0;
}

/** Somente para testes: quantas chaves vivas o limitador guarda. */
export function rateLimitKeys(): number {
  return store().size;
}

/** 10 tentativas / 10 minutos por IP no login e no cadastro (FR-062). */
export const AUTH_RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 10 };
