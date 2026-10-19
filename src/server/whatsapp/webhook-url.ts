import { getEnv } from "@/lib/env";

/**
 * Onde esta instância recebe os webhooks da Meta.
 *
 * A URL é fixa: `APP_BASE_URL` + `/api/webhooks/<canal>/<verify token>`. O
 * verify token faz de segmento secreto da rota (camada 1 do webhook) e é
 * o mesmo que a Meta envia no handshake, então a URL é tratada como uma
 * senha e jamais é escrita inteira em um log.
 *
 * Porta única para construí-la: a tela que a mostra, o registro
 * automático na Meta e o mock a tomam daqui, para que não haja duas formas
 * de montá-la que um dia deixem de coincidir.
 */
export type WebhookChannel = "wa" | "ig" | "messenger" | "tiktok";

/** Rota (sem origem) do webhook de um canal. */
export function webhookPath(channel: WebhookChannel = "wa"): string {
  return `/api/webhooks/${channel}/${getEnv().META_WEBHOOK_VERIFY_TOKEN}`;
}

/** URL pública completa do webhook de um canal. */
export function webhookUrl(channel: WebhookChannel = "wa"): string {
  const base = getEnv().APP_BASE_URL.replace(/\/$/, "");
  return `${base}${webhookPath(channel)}`;
}

/** O verify token que a Meta deve enviar no handshake de qualquer canal. */
export function webhookVerifyToken(): string {
  return getEnv().META_WEBHOOK_VERIFY_TOKEN;
}
