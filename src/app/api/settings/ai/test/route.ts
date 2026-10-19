import { apiError, parseBody, withAuth } from "@/lib/api";
import { probeProvider } from "@/lib/ai/probe";
import { apiRoot } from "@/lib/ai/presets";
import { getAiCredentialPublic, marcarActiva } from "@/server/ai/credentials";
import {
  aiProbeSchema,
  baseUrlEfectiva,
  llaveParaProbar,
  vistaAjustesIa,
} from "@/server/ai/settings";

export const dynamic = "force-dynamic";

/**
 * «Testar conexão»: uma chamada mínima ao provedor com o que foi digitado no
 * formulário, SEM salvar nada. Sem chave no body, testa-se a salva;
 * se o provedor a aceitar e ela estava pausada, volta para `active` — o caminho
 * de «recarreguei o saldo» sem colar a mesma chave outra vez.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, aiProbeSchema);
  if (!body.ok) return body.response;

  const llave = await llaveParaProbar(session.organizationId, body.data.token);
  if (!llave) {
    return apiError(
      422,
      "sin_token",
      "Cole a chave do provedor para testar a conexão"
    );
  }

  const baseUrl = baseUrlEfectiva(body.data.provider, body.data.baseUrl);
  const result = await probeProvider({
    baseUrl,
    model: body.data.model,
    token: llave.token,
  });
  if (!result.ok) {
    const status =
      result.code === "unreachable" ||
      result.code === "timeout" ||
      result.code === "provider_error"
        ? 503
        : 422;
    return apiError(status, result.code, result.message);
  }

  let reactivada = false;
  if (llave.guardada) {
    const cred = await getAiCredentialPublic(session.organizationId);
    // Só conta se foi testado CONTRA O MESMO provedor que está salvo:
    // que outra base URL aceite a chave não diz nada sobre a pausada.
    if (
      cred &&
      cred.status !== "active" &&
      apiRoot(cred.baseUrl) === apiRoot(baseUrl)
    ) {
      await marcarActiva(session.organizationId);
      reactivada = true;
    }
  }

  return Response.json({
    ok: true,
    latencyMs: result.latencyMs,
    reactivada,
    vista: reactivada ? await vistaAjustesIa(session.organizationId) : null,
  });
});
