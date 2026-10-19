import { after } from "next/server";
import { getEnv } from "@/lib/env";
import { isValidSignature, isValidWebhookToken } from "@/server/inbox/webhook";
import { processMetaInstagramPayload } from "@/server/instagram/ingest";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import { zernioSignatureFrom } from "@/server/zernio";
import { isAuthenticZernioDelivery, processZernioPayload } from "@/server/zernio/dispatch";

/**
 * 014 — Webhook público do canal do Instagram.
 *
 * Mesmo padrão de duas camadas do WhatsApp: o segmento [webhookToken]
 * deve coincidir (senão → 404 sem efeitos), e por cima a assinatura quando a
 * fonte a fornece. Aceita as duas fontes pela mesma URL porque os seus
 * payloads são inconfundíveis: a Meta envia `object: "instagram"`, a Zernio envia
 * um evento plano com `account`.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ webhookToken: string }> };

export async function GET(req: Request, { params }: Params) {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
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
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
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

  const isMeta =
    typeof payload === "object" &&
    payload !== null &&
    (payload as { object?: string }).object === "instagram";

  if (isMeta) {
    // A Meta assina cada entrega com o App Secret, igual ao WhatsApp. Sem
    // esta camada, quem conhecer a URL secreta pode injetar DMs falsas: o
    // agente responderia enviando um DM REAL pela conta do cliente
    // ao destinatário que o atacante escolher.
    if (!isValidSignature(rawBody, req.headers.get("x-hub-signature-256"), env.META_APP_SECRET)) {
      return new Response(null, { status: 401 });
    }
  } else {
    // Zernio: a assinatura é validada contra os segredos da organização dona
    // desta conta, que precisa ser resolvida lendo o corpo primeiro (023).
    if (!(await isAuthenticZernioDelivery(rawBody, zernioSignatureFrom(req.headers)))) {
      return new Response(null, { status: 401 });
    }
  }

  // A Zernio corta em 5 segundos e tenta de novo: confirma-se o recebimento AGORA e processa-se
  // fora da rota.
  after(async () => {
    try {
      // Um evento da Zernio é distribuído por plataforma: essa API entrega TODAS
      // as contas da chave por um único webhook, então esta URL também
      // pode trazer mensagens da página do Facebook.
      if (isMeta) {
        await processMetaInstagramPayload(payload);
      } else {
        await processZernioPayload(payload);
      }
    } catch (err) {
      console.error("[ig] error procesando payload:", err);
    }
  });

  return Response.json({ received: true });
}
