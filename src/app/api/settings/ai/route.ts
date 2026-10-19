import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  AiCredentialError,
  deleteAiCredential,
  saveAiCredential,
} from "@/server/ai/credentials";
import {
  aiSettingsPutSchema,
  baseUrlEfectiva,
  vistaAjustesIa,
} from "@/server/ai/settings";

export const dynamic = "force-dynamic";

/**
 * Ajustes → IA: o provedor, o modelo e a chave desta organização
 * (issue #85). A chave nunca sai daqui: a resposta traz os seus últimos 4,
 * o estado e, se o ambiente trouxer `OPENROUTER_*`, o fallback que é aplicado
 * enquanto não houver nada salvo.
 */

export const GET = withAuth(async (session) => {
  return Response.json(await vistaAjustesIa(session.organizationId));
});

export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, aiSettingsPutSchema);
  if (!body.ok) return body.response;

  try {
    await saveAiCredential({
      organizationId: session.organizationId,
      provider: body.data.provider,
      baseUrl: baseUrlEfectiva(body.data.provider, body.data.baseUrl),
      model: body.data.model,
      token: body.data.token,
    });
  } catch (err) {
    if (err instanceof AiCredentialError) {
      return apiError(422, err.code, err.message);
    }
    throw err;
  }
  return Response.json(await vistaAjustesIa(session.organizationId));
});

export const DELETE = withAuth(async (session) => {
  await deleteAiCredential(session.organizationId);
  return Response.json(await vistaAjustesIa(session.organizationId));
});
