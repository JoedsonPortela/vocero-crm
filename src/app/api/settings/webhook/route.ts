import { apiError, withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { isChannelEnabled } from "@/server/channels/enabled";
import { registerWebhookForNumber } from "@/server/whatsapp/connect";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { webhookUrl, webhookVerifyToken } from "@/server/whatsapp/webhook-url";

export const dynamic = "force-dynamic";

/**
 * Datos del webhook (FR-043). El de WhatsApp lo registra el CRM al guardar la
 * conexión; la URL y el verify token siguen a la vista para el backend de una
 * agencia o para pegarlos a mano si el registro automático falla.
 *
 * Los canales opcionales comparten el segmento secreto y el verify token, pero
 * cada uno tiene su ruta: Meta configura el webhook de Messenger y el de
 * Instagram por separado (productos distintos de la misma app), así que aquí
 * viajan las tres URLs y la pantalla de cada canal enseña la suya. Las de un
 * canal apagado van en null: no existen en esta instancia (ADR-001).
 */
export const GET = withAuth(async () => {
  const env = getEnv();
  const url = webhookUrl("wa");
  return Response.json({
    url,
    instagramUrl: isChannelEnabled("instagram") ? webhookUrl("ig") : null,
    messengerUrl: isChannelEnabled("messenger") ? webhookUrl("messenger") : null,
    // 022: la URL que se da de alta en Zernio para los mensajes de TikTok.
    tiktokUrl: isChannelEnabled("tiktok") ? webhookUrl("tiktok") : null,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    isHttps: url.startsWith("https://"),
    signatureLayer: Boolean(env.META_APP_SECRET),
  });
});

/**
 * Registrar el webhook en Meta con la conexión YA guardada.
 *
 * Guardar ya lo hace; esto es para las conexiones anteriores a ese cambio y
 * para reintentar si Meta falló, sin volver a pegar el token.
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
