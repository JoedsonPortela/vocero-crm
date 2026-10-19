import { timingSafeEqual } from "node:crypto";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { markBotSeen } from "@/server/bot/status";

/**
 * Autenticação da API de serviço `/api/bot/*`.
 *
 * Esta superfície NÃO é consumida pelo navegador: quem a consome é um cérebro externo
 * (um microsserviço próprio do operador, no mesmo servidor) que quer
 * conduzir a conversa sem que o token do WhatsApp saia do CRM.
 * Header `X-API-Key` contra `BOT_API_KEY` (env), comparação em tempo
 * constante. Sem `BOT_API_KEY` configurada, toda a superfície responde 401.
 *
 * Primeiro se autentica e DEPOIS se conta. Antes havia um único balde global
 * contado antes de olhar a chave: 600 requisições anônimas por minuto deixavam o
 * cérebro em 429 o resto da janela, e os clientes sem resposta.
 */

const MIN_KEY_LENGTH = 16;

/** A superfície está aberta: há `BOT_API_KEY` e ela não é fraca. Uma chave
 *  curta equivale a não tê-la (tudo responde 401). */
export function isBotKeyConfigured(): boolean {
  const key = process.env.BOT_API_KEY;
  return typeof key === "string" && key.length >= MIN_KEY_LENGTH;
}

/**
 * Orçamento do cérebro AUTENTICADO: 1200/min (20/s sustentados). A Nea faz
 * ~4-10 chamadas por turno de cliente (contexto, "digitando…", 1-3
 * mensagens e, quando aplica, ficha, handoff, agenda ou anexos): dá para
 * 120-300 turnos por minuto, acima do pico de um único negócio. Um
 * cérebro descontrolado em um loop fica em 20/s, carga que o monólito absorve
 * sem que a caixa de entrada perceba.
 */
export const BOT_API_BUDGET = { windowMs: 60_000, max: 1200 };

/**
 * Autenticações FALHADAS por IP: 30/min, e depois 429. Jamais tocam o
 * orçamento acima, e uma chave correta passa mesmo que seu IP esteja freado:
 * atrás do mesmo proxy (ou sem proxy, onde tudo é "local") o cérebro pode
 * compartilhar IP com quem inunda. Adivinhar a chave também não é o risco: ela tem
 * 16+ caracteres.
 */
export const BOT_AUTH_FAILURES = { windowMs: 60_000, max: 30 };

export function requireBotKey(req: Request): Response | null {
  if (!validBotKey(req.headers.get("x-api-key"))) {
    const ip = clientIp(req.headers);
    const fails = checkRateLimit(`bot-api-fail:${ip}`, BOT_AUTH_FAILURES);
    return fails.allowed
      ? apiError(401, "unauthorized", "No autorizado")
      : apiError(429, "rate_limited", "Demasiados intentos fallidos");
  }
  // «Quem responde»: a única marca que o cérebro externo deixa no CRM.
  // Marca-se ao autenticar, antes do orçamento: um cérebro freado por 429
  // continua sendo o que responde.
  markBotSeen();
  const rl = checkRateLimit("bot-api", BOT_API_BUDGET);
  if (!rl.allowed) return apiError(429, "rate_limited", "Demasiadas solicitudes");
  return null;
}

function validBotKey(provided: string | null): boolean {
  const expected = process.env.BOT_API_KEY;
  if (!expected || !isBotKeyConfigured() || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Organização única da instância (self-hosted, um negócio). Cacheada em
 * memória: a instância jamais muda de organização em tempo de execução.
 */
let cachedOrgId: string | null = null;

export async function resolveInstanceOrg(): Promise<string | null> {
  if (cachedOrgId) return cachedOrgId;
  const db = getDb();
  const rows = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .limit(1);
  cachedOrgId = rows[0]?.id ?? null;
  return cachedOrgId;
}

/** Só para testes. */
export function resetInstanceOrgCache(): void {
  cachedOrgId = null;
}
