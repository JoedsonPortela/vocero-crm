import { apiError, parseBody, withAuth } from "@/lib/api";
import { listModels } from "@/lib/ai/probe";
import {
  aiModelsSchema,
  baseUrlEfectiva,
  llaveParaProbar,
} from "@/server/ai/settings";

export const dynamic = "force-dynamic";

/**
 * «Buscar modelos»: `GET {base}/v1/models` com a chave digitada (ou a
 * salva). Um provedor que não publica a lista não é um erro: informa-se
 * (`soportado: false`) e o modelo é digitado à mão.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, aiModelsSchema);
  if (!body.ok) return body.response;

  const llave = await llaveParaProbar(session.organizationId, body.data.token);
  if (!llave) {
    return apiError(
      422,
      "sin_token",
      "Cole a chave do provedor para obter os modelos"
    );
  }

  const baseUrl = baseUrlEfectiva(body.data.provider, body.data.baseUrl);
  const result = await listModels({ baseUrl, token: llave.token });
  if (result.ok) {
    return Response.json({ soportado: true, modelos: result.modelos });
  }
  if (result.code === "unsupported") {
    return Response.json({
      soportado: false,
      modelos: [],
      mensaje: result.message,
    });
  }
  const status =
    result.code === "invalid_token" || result.code === "bad_url" ? 422 : 503;
  return apiError(status, result.code, result.message);
});
