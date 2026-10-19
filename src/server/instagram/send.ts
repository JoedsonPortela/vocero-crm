import { MetaApiError } from "@/lib/meta/client";
import type { InstagramCredentials } from "@/server/instagram/credentials";

/**
 * 014 — Fronteira de saída do canal do Instagram (Constituição II: toda
 * requisição a uma plataforma passa por um único módulo).
 *
 * Dois transportes, mesma assinatura: a Zernio (API unificada) e a Meta direto
 * (graph.instagram.com). Ambos devolvem o id da mensagem na plataforma.
 */

const ZERNIO_BASE = process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1";
const IG_GRAPH_BASE =
  process.env.IG_GRAPH_BASE_URL ?? "https://graph.instagram.com";
const IG_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION ?? "v25.0";

/** O Instagram corta o texto em 1000 BYTES (não caracteres): com acentos e
 * emojis a margem real é menor do que aparenta. */
export const IG_TEXT_MAX_BYTES = 1000;

export function fitsInstagramText(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= IG_TEXT_MAX_BYTES;
}

export type InstagramSendResult = { platformMessageId: string };

/**
 * Envia texto pelo transporte correspondente.
 *
 * `recipient` é o IGSID (sem o prefixo `ig:`); `threadRef` é o
 * conversationId opaco da Zernio, que só é necessário nesse transporte.
 */
export async function sendInstagramText(input: {
  credentials: InstagramCredentials;
  recipient: string;
  threadRef: string | null;
  text: string;
  /** Fora da janela de 24 h o Instagram só admite HUMAN_AGENT. */
  humanAgentTag?: boolean;
}): Promise<InstagramSendResult> {
  return input.credentials.source === "zernio"
    ? sendViaZernio(input)
    : sendViaMeta(input);
}

async function sendViaZernio(input: {
  credentials: InstagramCredentials;
  recipient: string;
  threadRef: string | null;
  text: string;
  humanAgentTag?: boolean;
}): Promise<InstagramSendResult> {
  const { credentials, threadRef } = input;
  if (!threadRef) {
    throw new MetaApiError(
      "La conversacion no tiene referencia de hilo en Zernio",
      { status: 400 }
    );
  }
  const body: Record<string, unknown> = {
    accountId: credentials.accountRef,
    message: input.text,
  };
  if (input.humanAgentTag) {
    body.messagingType = "MESSAGE_TAG";
    body.messageTag = "HUMAN_AGENT";
  }

  const res = await fetchJson(
    `${ZERNIO_BASE}/inbox/conversations/${encodeURIComponent(threadRef)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const id =
    (res as { message?: { id?: string }; id?: string }).message?.id ??
    (res as { id?: string }).id ??
    `zernio_${Date.now()}`;
  return { platformMessageId: String(id) };
}

async function sendViaMeta(input: {
  credentials: InstagramCredentials;
  recipient: string;
  text: string;
  humanAgentTag?: boolean;
}): Promise<InstagramSendResult> {
  const { credentials } = input;
  const body: Record<string, unknown> = {
    recipient: { id: input.recipient },
    message: { text: input.text },
  };
  if (input.humanAgentTag) {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "HUMAN_AGENT";
  }

  // O host é graph.instagram.com, NÃO graph.facebook.com: é o erro mais
  // comum desta integração e devolve uma falha de permissões que confunde.
  const res = await fetchJson(
    `${IG_GRAPH_BASE}/${IG_GRAPH_VERSION}/${credentials.igUserId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const id = (res as { message_id?: string }).message_id ?? `ig_${Date.now()}`;
  return { platformMessageId: String(id) };
}

/**
 * Traduz as falhas das duas plataformas para o MetaApiError que o resto do
 * CRM já sabe interpretar (incluindo `isAuthError`, que distingue token morto
 * de soluço transitório, e que custou um incidente aprender).
 */
async function fetchJson(
  url: string,
  init: RequestInit
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    throw new MetaApiError("Não foi possível contatar a API do Instagram", {
      status: 0,
      details: cause,
    });
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON: guarda-se o texto bruto
  }

  if (!res.ok) {
    const err = json as
      | { error?: { message?: string; code?: number } | string }
      | null;
    const message =
      typeof err?.error === "string"
        ? err.error
        : err?.error?.message ?? `HTTP ${res.status}`;
    const code = typeof err?.error === "object" ? err.error?.code ?? null : null;
    throw new MetaApiError(message, {
      status: res.status,
      code,
      details: json ?? text,
    });
  }
  return json;
}
