import { after } from "next/server";
import { getEnv } from "@/lib/env";
import { isValidSignature, isValidWebhookToken } from "@/server/inbox/webhook";
import { processMetaPagePayload } from "@/server/messenger/ingest";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import { looksLikeMetaPayload, zernioSignatureFrom } from "@/server/zernio";
import { isAuthenticZernioDelivery, processZernioPayload } from "@/server/zernio/dispatch";

/**
 * 017 — Webhook público do canal do Messenger.
 *
 * Mesmo padrão de duas camadas dos de WhatsApp e Instagram: o segmento
 * [webhookToken] deve coincidir (senão → 404 sem efeitos) e por cima a assinatura.
 * Aceita as duas fontes pela mesma URL porque os seus payloads são
 * inconfundíveis: a Meta envia `object: "page"`, a Zernio envia um evento plano
 * com `account`.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ webhookToken: string }> };

export async function GET(req: Request, { params }: Params) {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  const { webhookToken } = await params;
  const env = getEnv();
  if (!isValidWebhookToken(webhookToken, env.META_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(null, { status: 404 });
  }

  // Handshake da Meta (a Zernio não o faz, mas responder não atrapalha).
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.META_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response(null, { status: 403 });
}

export async function POST(req: Request, { params }: Params) {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  const { webhookToken } = await params;
  const env = getEnv();
  if (!isValidWebhookToken(webhookToken, env.META_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(null, { status: 404 });
  }

  const rawBody = await req.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Corpo ilegível: 200 mesmo assim, para que a fonte não tente de novo em vão.
    return Response.json({ received: true });
  }

  const isMeta = looksLikeMetaPayload(payload, "page");

  if (isMeta) {
    // A Meta assina cada entrega com o App Secret. Sem esta camada, quem conheça
    // a URL secreta pode injetar mensagens falsas: o agente as responderia
    // enviando uma mensagem REAL pela página ao destinatário que o atacante
    // escolher.
    if (
      !isValidSignature(
        rawBody,
        req.headers.get("x-hub-signature-256"),
        env.META_APP_SECRET
      )
    ) {
      return new Response(null, { status: 401 });
    }
  } else {
    // Zernio: a assinatura é validada contra os segredos da organização dona
    // desta conta, que precisa ser resolvida lendo o corpo primeiro (023).
    if (!(await isAuthenticZernioDelivery(rawBody, zernioSignatureFrom(req.headers)))) {
      return new Response(null, { status: 401 });
    }
  }

  // A Zernio corta em 5 segundos e tenta de novo; a Meta também. Confirma-se o recebimento
  // AGORA e processa-se fora da rota.
  after(async () => {
    try {
      // Um evento da Zernio é distribuído por plataforma: a mesma URL serve para
      // o Instagram e para o Messenger, porque a Zernio entrega tudo por um webhook.
      if (isMeta) await processMetaPagePayload(payload);
      else await processZernioPayload(payload);
    } catch (err) {
      console.error("[messenger] error procesando payload:", err);
    }
  });

  return Response.json({ received: true });
}
