import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Autenticação em duas camadas do webhook (contrato webhook.md / DV-VC-02).
 * Este módulo é puro (sem BD) para poder ser testado unitariamente.
 */

/** Comparação timing-safe de strings de comprimento arbitrário. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Camada 1: o segmento da rota deve coincidir com o verify token. */
export function isValidWebhookToken(
  segment: string,
  verifyToken: string
): boolean {
  return verifyToken.length > 0 && safeEqual(segment, verifyToken);
}

/**
 * Camada 2 (opcional): assinatura HMAC-SHA256 da Meta sobre o corpo CRU.
 * Devolve true se não houver segredo configurado (camada desativada).
 */
export function isValidSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined
): boolean {
  if (!appSecret) return true;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");
  return safeEqual(signatureHeader.slice("sha256=".length), expected);
}

/* ---------- Tipos do payload da Meta (subconjunto suportado) ---------- */

/** Payload de um anexo em uma mensagem do webhook (008). */
export type WebhookMediaPayload = {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  /** Só documentos. */
  filename?: string;
  /** Só áudio: true se for nota de voz. */
  voice?: boolean;
};

export type WebhookLocation = {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
};

/**
 * 016 — Objeto `referral`: SÓ chega quando a mensagem vem de um anúncio
 * Click-to-WhatsApp, e normalmente só na PRIMEIRA mensagem da
 * conversa. Seu `ctwa_clid` é o que permite devolver à Meta o
 * desfecho desse lead; o resto são dados do criativo.
 */
export type WebhookReferral = {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  media_type?: string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
  ctwa_clid?: string;
};

/**
 * #78 — Resposta a um botão de resposta rápida de um TEMPLATE
 * (`type: "button"`): `text` é o rótulo que o cliente viu e `payload` o
 * que foi definido ao criar o template (na prática, o mesmo rótulo).
 */
export type WebhookButtonReply = {
  text?: string;
  payload?: string;
};

/**
 * #78 — Resposta a uma mensagem INTERATIVA (`type: "interactive"`): um botão
 * (`button_reply`) ou uma linha de lista (`list_reply`). A Meta põe em `type`
 * qual dos dois vem.
 */
export type WebhookInteractiveReply = {
  type?: string;
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string; description?: string };
};

export type WebhookMessage = {
  /** Telefone do remetente. OPCIONAL desde a migração da Meta para BSUID (003). */
  from?: string;
  /** Business-Scoped User ID do remetente quando não há telefone (003). */
  from_user_id?: string;
  /** Destinatário — presente em echoes de coexistence (008): o wa_id do lead. */
  to?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WebhookMediaPayload;
  video?: WebhookMediaPayload;
  audio?: WebhookMediaPayload;
  document?: WebhookMediaPayload;
  sticker?: WebhookMediaPayload;
  location?: WebhookLocation;
  contacts?: unknown[];
  /** #78: resposta a um botão de template. */
  button?: WebhookButtonReply;
  /** #78: resposta a um botão ou a uma lista de uma mensagem interativa. */
  interactive?: WebhookInteractiveReply;
  /** A mensagem à qual responde (botões, citações): `id` é o seu wa_message_id. */
  context?: { from?: string; id?: string };
  /** 016: origem do anúncio, quando a conversa nasceu de um. */
  referral?: WebhookReferral;
};

export type WebhookStatus = {
  id: string;
  status: string;
  timestamp: string;
  recipient_id?: string;
  errors?: { code: number; title?: string; message?: string }[];
};

export type WebhookValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string; user_id?: string }[];
  messages?: WebhookMessage[];
  /** Echoes de coexistence (008): mensagens enviadas pelo app do telefone. */
  message_echoes?: WebhookMessage[];
  statuses?: WebhookStatus[];
  // message_template_status_update
  event?: string;
  message_template_name?: string;
  message_template_language?: string;
  message_template_id?: number | string;
  reason?: string | null;
};

export type WebhookChange = { field?: string; value?: WebhookValue };

export type WebhookPayload = {
  object?: string;
  entry?: { id?: string; changes?: WebhookChange[] }[];
};
