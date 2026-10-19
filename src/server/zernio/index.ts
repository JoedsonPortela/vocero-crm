import { createHmac, timingSafeEqual } from "node:crypto";
import { MetaApiError } from "@/lib/meta/client";

/**
 * 017 — Transporte da Zernio, compartilhado pelos canais que o usam.
 *
 * A Zernio é uma API unificada: UMA conta e UMA chave entregam as mensagens de
 * todas as plataformas conectadas (Instagram, Facebook/Messenger, X…) pelo
 * mesmo webhook, e responde-se pelo mesmo endpoint de conversas. O que
 * distingue o canal é `account.platform`, e o que roteia para a organização
 * é `account.id`.
 *
 * Isto vive separado de cada canal de propósito: a verificação da assinatura é
 * um controle de segurança, e duas implementações do mesmo controle são dois
 * lugares onde errar. O canal decide QUAL plataforma aceita; este módulo
 * resolve COMO se fala com a Zernio.
 */

export const ZERNIO_BASE = process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1";

/** Cabeçalhos com os quais a Zernio assina suas entregas (o segundo é herdado). */
const SIGNATURE_HEADERS = ["x-zernio-signature", "x-late-signature"] as const;

export function zernioSignatureFrom(headers: Headers): string | null {
  for (const h of SIGNATURE_HEADERS) {
    const value = headers.get(h);
    if (value) return value;
  }
  return null;
}

/**
 * Assinatura da Zernio: HMAC-SHA256 em hex do corpo CRU, com o segredo dessa
 * conta. Sem segredo configurado a camada fica desativada e protege só o
 * segmento secreto da URL — mesmo tratamento que o webhook do WhatsApp dá a
 * `META_APP_SECRET`.
 */
export function isValidZernioSignature(
  rawBody: string,
  signature: string | null,
  secret: string | null
): boolean {
  if (!secret) return true;
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 023 — Assinatura válida contra QUALQUER um dos segredos. Um webhook da Zernio
 * assina com um só segredo e atende todos os canais dessa chave; o CRM
 * guarda um por canal, e se ao capturá-los não ficaram iguais, um canal
 * rejeitava tudo com 401. Sem segredos a camada fica desativada, igual a
 * `isValidZernioSignature`.
 */
export function isValidZernioSignatureAny(
  rawBody: string,
  signature: string | null,
  secrets: readonly string[]
): boolean {
  if (secrets.length === 0) return true;
  return secrets.some((s) => isValidZernioSignature(rawBody, signature, s));
}

/** O evento da Zernio, no que interessa ao Vocero. */
export type ZernioEvent = {
  id?: string;
  event?: string;
  message?: {
    /**
     * Id da Zernio, NÃO o da plataforma (esse vem em
     * `platformMessageId`). É o que deduplica: mantém-se entre reentregas
     * da mesma mensagem, que é justamente o que precisa ser colapsado.
     */
    id?: string;
    platformMessageId?: string;
    /**
     * Identificador OPACO da conversa. A própria API diz «format not to be
     * assumed»: seu endpoint de resposta o aceita tal como vier, seja da
     * listagem ou daqui. Não se analisa nem se compara com o da plataforma.
     */
    conversationId?: string;
    /** 022: a plataforma também vem na mensagem, não só na conta. */
    platform?: string;
    direction?: string;
    text?: string | null;
    /** Quando a pessoa a enviou, ISO-8601. Ver `zernioSentAtSeconds`. */
    sentAt?: string;
    attachments?: { type?: string; url?: string }[];
    sender?: { id?: string; name?: string | null; username?: string | null };
  };
  /** 022: a conversa também vem à parte; seu `id` é o `conversationId`. */
  conversation?: { id?: string };
  /**
   * 023: `profileId` é o do perfil que agrupa as contas. Serve para
   * corrigir uma conexão guardada com esse id em vez do da conta.
   */
  account?: { id?: string; accountId?: string; platform?: string; profileId?: string };
};

/**
 * Hora da mensagem em segundos, a que vem no evento e não a de chegada.
 *
 * Importa porque `lastInboundAt` é o que abre a janela de 24 h: carimbar com
 * a hora de ingestão faria com que uma reentrega atrasada —a Zernio tenta de novo com
 * backoff de até 24 h, e seu painel permite reenviar à mão— parecesse uma
 * mensagem recém-chegada, e o CRM ofereceria escrever livremente por uma janela
 * que na verdade já fechou. O envio seria rejeitado pela plataforma, e o
 * operador não teria como entender por quê.
 *
 * Sem `sentAt` utilizável cai-se na hora atual: é o que havia antes e
 * nunca é pior.
 */
export function zernioSentAtSeconds(sentAt: string | undefined): string {
  const ms = sentAt ? Date.parse(sentAt) : NaN;
  return String(Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000));
}

/** Lê o corpo cru como evento da Zernio; null se não for. */
export function parseZernioEvent(rawBody: string): ZernioEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const evt = parsed as ZernioEvent;
    // Um payload da Meta traz `object`; um da Zernio traz `account`. Sem
    // `account` não há a quem rotear, então não é um evento utilizável.
    return evt.account ? evt : null;
  } catch {
    return null;
  }
}

/** `true` se o corpo for um webhook da Meta (e, portanto, NÃO da Zernio). */
export function looksLikeMetaPayload(payload: unknown, object: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { object?: string }).object === object
  );
}

export type ZernioSendResult = { platformMessageId: string };

/**
 * Responde numa conversa da Zernio.
 *
 * `accountId` vai no corpo mesmo que a conversa já o implique (a API o exige).
 * `Idempotency-Key` evita que uma nova tentativa envie a mensagem duas
 * vezes: a chave natural é o id que o Vocero já gerou para esse envio.
 */
export async function sendZernioMessage(input: {
  token: string;
  accountId: string | null;
  conversationId: string | null;
  text: string;
  /** Fora da janela de 24 h, a única etiqueta admitida. */
  humanAgentTag?: boolean;
  idempotencyKey?: string;
}): Promise<ZernioSendResult> {
  if (!input.conversationId) {
    throw new MetaApiError(
      "La conversación no tiene referencia de hilo en Zernio",
      { status: 400 }
    );
  }

  const body: Record<string, unknown> = {
    accountId: input.accountId,
    message: input.text,
  };
  if (input.humanAgentTag) {
    body.messagingType = "MESSAGE_TAG";
    body.messageTag = "HUMAN_AGENT";
  }

  const res = await zernioFetch(
    `/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages`,
    {
      method: "POST",
      token: input.token,
      body,
      ...(input.idempotencyKey
        ? { headers: { "Idempotency-Key": input.idempotencyKey } }
        : {}),
    }
  );

  // A API responde `{ success, data: { messageId } }`. As outras duas formas
  // são as que se liam antes da 022 e são mantidas por via das dúvidas; sem
  // nenhuma, um id próprio para que a mensagem não fique sem referência.
  const id =
    (res as { data?: { messageId?: string } }).data?.messageId ??
    (res as { message?: { id?: string }; id?: string }).message?.id ??
    (res as { id?: string }).id ??
    `zernio_${Date.now()}`;
  return { platformMessageId: String(id) };
}

/** Verifica que a chave serve (usado antes de salvar uma conexão). */
export async function verifyZernioToken(token: string): Promise<void> {
  await zernioFetch("/inbox/conversations?limit=1", { token });
}

/**
 * Traduz as falhas da Zernio para o MetaApiError que o resto do CRM já sabe
 * interpretar — incluindo `isAuthError`, que distingue uma chave morta de um
 * soluço transitório, e que custou um incidente aprender.
 */
export async function zernioFetch(
  path: string,
  opts: {
    method?: "GET" | "POST" | "PUT";
    /** 023: encurta a espera; sem ele, a do runtime. */
    timeoutMs?: number;
    token: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${ZERNIO_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
  } catch (cause) {
    throw new MetaApiError("Não foi possível contatar a API do Zernio", {
      status: 0,
      details: cause,
    });
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON: guarda-se o texto bruto nos detalhes
  }

  if (!res.ok) {
    const err = json as { error?: { message?: string } | string } | null;
    const message =
      typeof err?.error === "string"
        ? err.error
        : (err?.error?.message ?? `HTTP ${res.status}`);
    throw new MetaApiError(message, {
      status: res.status,
      details: json ?? text,
    });
  }
  return json;
}
