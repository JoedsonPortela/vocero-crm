import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  desconectarCanal,
  getCredentialsByOrg,
  saveCredentials,
  tokenLast4,
} from "@/server/whatsapp/credentials";
import {
  registerWebhookForNumber,
  testConnection,
  unregisterWebhookForNumber,
} from "@/server/whatsapp/connect";
import {
  webhookPath,
  webhookUrl,
  webhookVerifyToken,
} from "@/server/whatsapp/webhook-url";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      displayPhoneNumber: creds.displayPhoneNumber,
      verifiedName: creds.verifiedName,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
    },
  });
});

const putSchema = z.object({
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

/**
 * Salva a conexão: revalida na Meta, criptografa (FR-040) e registra o
 * webhook desta instância no número.
 *
 * Antes o CRM só assinava o app na WABA e a URL precisava ser colada à mão no
 * painel da Meta. Se a Meta recusar o cadastro, a conexão JÁ está salva e é
 * válida: avisa-se em `webhook` e o cartão do webhook oferece tentar de novo
 * (ou colar a URL à mão, que continua à vista).
 */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  const check = await testConnection(body.data.phoneNumberId, body.data.token);
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  await saveCredentials({
    organizationId: session.organizationId,
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token: body.data.token,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });

  const webhook = await registerWebhookForNumber({
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token: body.data.token,
    webhookUrl: webhookUrl("wa"),
    verifyToken: webhookVerifyToken(),
  });

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
    webhook,
  });
});

/**
 * Desconecta o número. Sem isso, conectar era mão única: a unicidade do número
 * impedia movê-lo para outra instância e não havia tela onde largá-lo.
 * pela qual soltá-lo.
 *
 * Primeiro remove o override do webhook que o salvar definiu — com o token
 * ainda disponível; sem ele não seria possível — e depois apaga as credenciais. Não
 * apaga a bandeja: as conversas são da organização, não da
 * conexão. Idempotente: sem conexão responde 200 do mesmo jeito.
 */
export const DELETE = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  if (creds) {
    await unregisterWebhookForNumber({
      phoneNumberId: creds.phoneNumberId,
      token: creds.token,
      webhookPath: webhookPath("wa"),
    });
  }
  await desconectarCanal(session.organizationId);
  return Response.json({ ok: true });
});
