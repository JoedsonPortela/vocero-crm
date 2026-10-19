import { after } from "next/server";
import { getEnv } from "@/lib/env";
import { isValidWebhookToken } from "@/server/inbox/webhook";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import { zernioSignatureFrom } from "@/server/zernio";
import { isAuthenticZernioDelivery, processZernioPayload } from "@/server/zernio/dispatch";

/**
 * 022 — Webhook público do canal do TikTok.
 *
 * Mesmo padrão de duas camadas dos demais: o segmento [webhookToken] deve
 * coincidir (senão → 404 sem efeitos) e por cima a assinatura. Aqui só há uma
 * fonte, a Zernio: o TikTok não entrega mensagens a um app próprio.
 *
 * A Zernio entrega TODAS as plataformas de uma chave por um mesmo webhook, então
 * esta URL também recebe Instagram e Messenger se essas contas estiverem
 * conectadas: o `processZernioPayload` distribui por plataforma, igual ao que fazem
 * as outras duas rotas com um evento do TikTok.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ webhookToken: string }> };

/** A Zernio não faz handshake; isto serve para conferir a URL manualmente. */
export async function GET(_req: Request, { params }: Params) {
  if (!isChannelEnabled("tiktok")) return channelDisabledResponse();
  const { webhookToken } = await params;
  if (!isValidWebhookToken(webhookToken, getEnv().META_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ ok: true });
}

export async function POST(req: Request, { params }: Params) {
  if (!isChannelEnabled("tiktok")) return channelDisabledResponse();
  const { webhookToken } = await params;
  if (!isValidWebhookToken(webhookToken, getEnv().META_WEBHOOK_VERIFY_TOKEN)) {
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

  // A assinatura é validada contra os segredos da organização dona DESTA
  // conta, que precisa ser resolvida lendo o corpo primeiro (023). Sem esta camada, quem conheça a URL pode
  // injetar mensagens falsas e fazer o agente responder de verdade.
  if (!(await isAuthenticZernioDelivery(rawBody, zernioSignatureFrom(req.headers)))) {
    return new Response(null, { status: 401 });
  }

  // A Zernio corta em 5 segundos e tenta de novo: confirma-se o recebimento AGORA e processa-se
  // fora da rota.
  after(async () => {
    try {
      await processZernioPayload(payload);
    } catch (err) {
      console.error("[tiktok] error procesando payload:", err);
    }
  });

  return Response.json({ received: true });
}
