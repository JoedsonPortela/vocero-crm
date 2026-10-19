import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  getInstagramCredentialsByOrg,
  saveInstagramCredentials,
  tokenLast4,
} from "@/server/instagram/credentials";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import { ensureWebhookForOrg } from "@/server/zernio/conexiones";
import { accountHealth, zernioAccountName } from "@/server/zernio/cuentas";
import { resolveZernioAccount } from "@/server/zernio/guardar";

export const dynamic = "force-dynamic";

/** 014 — Estado da conexão do Instagram (o token nunca sai inteiro). */
export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
  const creds = await getInstagramCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      source: creds.source,
      igUserId: creds.igUserId,
      accountRef: creds.accountRef,
      username: creds.username,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
    },
  });
});

const putSchema = z.object({
  source: z.enum(["zernio", "meta"]),
  /** Com a Meta, obrigatório. Com a Zernio, sai da conta (023). */
  igUserId: z.string().trim().min(1).nullish(),
  /** Com a Zernio: opcional se a chave tiver uma única conta do Instagram. */
  accountRef: z.string().trim().min(1).nullish(),
  username: z.string().trim().nullish(),
  token: z.string().trim().min(1),
  webhookSecret: z.string().trim().min(1).nullish(),
});

/**
 * Salva a conexão validando ANTES na plataforma, igual ao
 * wizard do WhatsApp: um token que não funciona não chega ao banco. Só o
 * proprietário da organização pode fazê-lo (023: esta rota não verificava
 * isso; o Messenger e o TikTok verificam).
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Somente o proprietário pode conectar o Instagram");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  const previa = await getInstagramCredentialsByOrg(session.organizationId);
  // Sem segredo novo, mantém-se o que havia: reconectar não deve desligar a
  // verificação de assinatura.
  const webhookSecret =
    data.webhookSecret ??
    (previa?.source === data.source ? previa.webhookSecret : null) ??
    null;

  if (data.source === "zernio") {
    // 023: a conta é resolvida na Zernio, não é salva às cegas.
    const cuenta = await resolveZernioAccount(data.token, data.accountRef, "instagram");
    if (!cuenta.ok) return cuenta.response;
    const username = cuenta.account.username?.replace(/^@/, "") || data.username || null;

    await saveInstagramCredentials({
      organizationId: session.organizationId,
      source: "zernio",
      igUserId: cuenta.account.platformUserId || data.igUserId || cuenta.account._id,
      accountRef: cuenta.account._id,
      username,
      token: data.token,
      webhookSecret,
    });
    const webhook = await ensureWebhookForOrg(session.organizationId, {
      secret: data.webhookSecret,
    });
    return Response.json({
      ok: true,
      username,
      accountRef: cuenta.account._id,
      accountName: zernioAccountName(cuenta.account),
      health: accountHealth(cuenta.account, "instagram"),
      webhook,
    });
  }

  if (!data.igUserId) {
    return apiError(
      422,
      "invalid_body",
      "Com um app próprio da Meta é preciso o ID da conta do Instagram"
    );
  }
  const check = await verify({ token: data.token, igUserId: data.igUserId });
  if (!check.ok) {
    return apiError(check.status, check.code, check.message);
  }

  await saveInstagramCredentials({
    organizationId: session.organizationId,
    source: "meta",
    igUserId: data.igUserId,
    accountRef: null,
    username: check.username ?? data.username ?? null,
    token: data.token,
    webhookSecret,
  });

  return Response.json({ ok: true, username: check.username ?? null });
});

type Check =
  | { ok: true; username: string | null }
  | { ok: false; status: number; code: string; message: string };

/** Fonte Meta: o token precisa ser DESSA conta do Instagram. */
async function verify(data: { token: string; igUserId: string }): Promise<Check> {
  const url = `${process.env.IG_GRAPH_BASE_URL ?? "https://graph.instagram.com"}/${
    process.env.META_GRAPH_API_VERSION ?? "v25.0"
  }/me?fields=id,username`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
  } catch {
    return {
      ok: false,
      status: 503,
      code: "platform_unavailable",
      message: "Não foi possível contatar a plataforma; tente novamente",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: 422,
      code: "invalid_token",
      message: "O token do Instagram não é válido ou não tem permissão de mensagens",
    };
  }

  const json = (await res.json().catch(() => null)) as {
    id?: string;
    username?: string;
  } | null;
  if (json?.id && json.id !== data.igUserId) {
    return {
      ok: false,
      status: 422,
      code: "id_mismatch",
      message: `El IG_ID del token es ${json.id}, no ${data.igUserId}`,
    };
  }
  return { ok: true, username: json?.username ?? null };
}
