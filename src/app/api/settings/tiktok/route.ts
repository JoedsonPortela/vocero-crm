import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import {
  getTiktokCredentialsByOrg,
  saveTiktokCredentials,
  tokenLast4,
} from "@/server/tiktok/credentials";
import { ensureWebhookForOrg } from "@/server/zernio/conexiones";
import { accountHealth, zernioAccountName } from "@/server/zernio/cuentas";
import { resolveZernioAccount } from "@/server/zernio/guardar";

export const dynamic = "force-dynamic";

/** 022 — Estado da conexão do TikTok (a chave nunca sai inteira). */
export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("tiktok")) return channelDisabledResponse();
  const creds = await getTiktokCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      source: creds.source,
      accountRef: creds.accountRef,
      username: creds.username,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
      hasWebhookSecret: Boolean(creds.webhookSecret),
    },
  });
});

const putSchema = z.object({
  /**
   * `accountId` da conta do TikTok na Zernio. Opcional se a chave tiver
   * uma única conta do TikTok (023).
   */
  accountRef: z.string().trim().min(1).nullish(),
  /** Usuário do TikTok, só para exibi-lo: não roteia nada. */
  username: z.string().trim().min(1).max(100).nullish(),
  token: z.string().trim().min(1),
  webhookSecret: z.string().trim().min(1).nullish(),
});

/**
 * Salva a conexão validando ANTES a chave na Zernio, igual aos
 * demais canais: uma chave que não funciona não chega ao banco. Só o
 * proprietário da organização pode fazê-lo.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("tiktok")) return channelDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Somente o proprietário pode conectar o TikTok");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  // 023: a conta é resolvida na Zernio, não é salva às cegas.
  const cuenta = await resolveZernioAccount(body.data.token, body.data.accountRef, "tiktok");
  if (!cuenta.ok) return cuenta.response;

  const previa = await getTiktokCredentialsByOrg(session.organizationId);
  const username =
    (cuenta.account.username ?? body.data.username)?.replace(/^@/, "") || null;
  await saveTiktokCredentials({
    organizationId: session.organizationId,
    accountRef: cuenta.account._id,
    username,
    token: body.data.token,
    // Sem segredo novo, mantém-se o que havia: reconectar não deve desligar
    // a verificação de assinatura.
    webhookSecret: body.data.webhookSecret ?? previa?.webhookSecret ?? null,
  });
  const webhook = await ensureWebhookForOrg(session.organizationId, {
      secret: body.data.webhookSecret,
    });

  return Response.json({
    ok: true,
    username,
    accountRef: cuenta.account._id,
    accountName: zernioAccountName(cuenta.account),
    // Uma conta pessoal é salva do mesmo jeito, mas isso é informado: o TikTok não entrega
    // mensagens até que seja Business.
    health: accountHealth(cuenta.account, "tiktok"),
    webhook,
  });
});
