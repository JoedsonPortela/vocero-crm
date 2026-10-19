import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { graphRequest, MetaApiError } from "@/lib/meta/client";
import {
  getMessengerCredentialsByOrg,
  saveMessengerCredentials,
  tokenLast4,
} from "@/server/messenger/credentials";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import { ensureWebhookForOrg } from "@/server/zernio/conexiones";
import { accountHealth, zernioAccountName } from "@/server/zernio/cuentas";
import { resolveZernioAccount } from "@/server/zernio/guardar";

export const dynamic = "force-dynamic";

/** 017 — Estado da conexão do Messenger (o token nunca sai inteiro). */
export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  const creds = await getMessengerCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      source: creds.source,
      pageId: creds.pageId,
      pageName: creds.pageName,
      accountRef: creds.accountRef,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
    },
  });
});

const putSchema = z.object({
  source: z.enum(["zernio", "meta"]).default("meta"),
  pageId: z.string().trim().min(1).nullish(),
  accountRef: z.string().trim().min(1).nullish(),
  token: z.string().trim().min(1),
  webhookSecret: z.string().trim().min(1).nullish(),
});

/**
 * Salva a conexão validando ANTES na plataforma, igual ao wizard
 * do WhatsApp: um token que não funciona não chega ao banco. Só o proprietário
 * da organização pode fazê-lo.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Somente o proprietário pode conectar a página");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  // `.default()` deixa o tipo opcional mesmo com o Zod sempre preenchendo: fixa-se
  // aqui para que o resto do handler trabalhe com um valor fechado.
  const data = { ...body.data, source: body.data.source ?? "meta" };

  if (data.source === "meta" && !data.pageId) {
    return apiError(
      422,
      "invalid_body",
      "No modo Meta é preciso o ID da página"
    );
  }

  const previa = await getMessengerCredentialsByOrg(session.organizationId);
  // Sem segredo novo, mantém-se o que havia: reconectar não deve desligar a
  // verificação de assinatura.
  const webhookSecret =
    data.webhookSecret ??
    (previa?.source === data.source ? previa.webhookSecret : null) ??
    null;

  if (data.source === "zernio") {
    // 023: a conta é resolvida na Zernio, não é salva às cegas. Dela
    // saem também a página e o seu nome.
    const cuenta = await resolveZernioAccount(data.token, data.accountRef, "messenger");
    if (!cuenta.ok) return cuenta.response;
    const pageName = zernioAccountName(cuenta.account);

    await saveMessengerCredentials({
      organizationId: session.organizationId,
      source: "zernio",
      pageId: cuenta.account.metadata?.selectedPageId ?? data.pageId ?? null,
      pageName,
      accountRef: cuenta.account._id,
      token: data.token,
      webhookSecret,
    });
    const webhook = await ensureWebhookForOrg(session.organizationId, {
      secret: data.webhookSecret,
    });
    return Response.json({
      ok: true,
      pageName,
      accountRef: cuenta.account._id,
      accountName: pageName,
      health: accountHealth(cuenta.account, "messenger"),
      webhook,
    });
  }

  const check = await verify(data);
  if (!check.ok) return apiError(check.status, check.code, check.message);

  await saveMessengerCredentials({
    organizationId: session.organizationId,
    source: "meta",
    pageId: data.pageId ?? null,
    pageName: check.pageName,
    accountRef: null,
    token: data.token,
    webhookSecret,
  });

  return Response.json({ ok: true, pageName: check.pageName });
});

type Check =
  | { ok: true; pageName: string | null }
  | { ok: false; status: number; code: string; message: string };

type VerifyInput = Omit<z.infer<typeof putSchema>, "source"> & {
  source: "zernio" | "meta";
};

/** Fonte Meta. */
async function verify(data: VerifyInput): Promise<Check> {
  // Meta: o token deve ser DESTA página. Um token de outra salvaria
  // credenciais que recebem webhooks de uma e respondem por outra.
  try {
    const res = await graphRequest<{ id?: string; name?: string }>(
      `${data.pageId}?fields=id,name`,
      { token: data.token }
    );
    if (res.id && res.id !== data.pageId) {
      return {
        ok: false,
        status: 422,
        code: "id_mismatch",
        message: `El token pertenece a la página ${res.id}, no a ${data.pageId}`,
      };
    }
    return { ok: true, pageName: res.name?.trim() || null };
  } catch (err) {
    return translate(
      err,
      "O token da página não é válido ou não tem permissão de mensagens (pages_messaging)"
    );
  }
}

function translate(err: unknown, invalidMessage: string): Check {
  if (err instanceof MetaApiError) {
    if (err.status === 0 || err.status >= 500) {
      return {
        ok: false,
        status: 503,
        code: "platform_unavailable",
        message: "Não foi possível contatar a plataforma; tente novamente",
      };
    }
    return { ok: false, status: 422, code: "invalid_token", message: invalidMessage };
  }
  throw err;
}
