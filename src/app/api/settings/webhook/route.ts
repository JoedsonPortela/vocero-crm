import { apiError, withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { isChannelEnabled } from "@/server/channels/enabled";
import { registerWebhookForNumber } from "@/server/whatsapp/connect";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { webhookUrl, webhookVerifyToken } from "@/server/whatsapp/webhook-url";

export const dynamic = "force-dynamic";

/**
 * Dados do webhook (FR-043). O do WhatsApp o CRM cadastra ao salvar a
 * conexão; a URL e o verify token continuam à vista para o backend de uma
 * agência ou para colá-los à mão se o cadastro automático falhar.
 *
 * Os canais opcionais compartilham o segmento secreto e o verify token, mas
 * cada um tem a sua rota: a Meta configura o webhook do Messenger e o do
 * Instagram separadamente (produtos distintos do mesmo app), então aqui
 * trafegam as três URLs e a tela de cada canal mostra a sua. As de um
 * canal desligado ficam em null: não existem nesta instância (ADR-001).
 */
export const GET = withAuth(async () => {
  const env = getEnv();
  const url = webhookUrl("wa");
  return Response.json({
    url,
    instagramUrl: isChannelEnabled("instagram") ? webhookUrl("ig") : null,
    messengerUrl: isChannelEnabled("messenger") ? webhookUrl("messenger") : null,
    // 022: a URL que é cadastrada na Zernio para as mensagens do TikTok.
    tiktokUrl: isChannelEnabled("tiktok") ? webhookUrl("tiktok") : null,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    isHttps: url.startsWith("https://"),
    signatureLayer: Boolean(env.META_APP_SECRET),
  });
});

/**
 * Registra o webhook na Meta com a conexão JÁ salva.
 *
 * Salvar já faz isso; isto serve para as conexões anteriores a essa mudança e
 * para tentar de novo se a Meta falhou, sem colar o token outra vez.
 */
export const POST = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  if (!creds) {
    return apiError(
      409,
      "sin_conexion",
      "Primeiro salve a conexão do WhatsApp."
    );
  }

  const resultado = await registerWebhookForNumber({
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    token: creds.token,
    webhookUrl: webhookUrl("wa"),
    verifyToken: webhookVerifyToken(),
  });
  if (!resultado.ok) {
    const status = resultado.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, resultado.code, resultado.message);
  }
  return Response.json(resultado);
});
