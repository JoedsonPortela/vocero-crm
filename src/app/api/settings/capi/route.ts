import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  atribucionDisabledResponse,
  atribucionEnabled,
} from "@/server/attribution/flag";
import {
  deleteCapiSettings,
  getCapiSettingsView,
  saveCapiSettings,
  stageBelongsToOrg,
} from "@/server/attribution/settings";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";

export const dynamic = "force-dynamic";

/**
 * 016 — A conexão do negócio com o seu dataset da Meta.
 *
 * Sem a flag `ATRIBUCION` isto não existe: 404, não 403 — não há nada a
 * revelar sobre um endpoint que esta instância não tem.
 */

export const GET = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  const capi = await getCapiSettingsView(session.organizationId);
  return Response.json({ capi });
});

const putSchema = z.object({
  datasetId: z.string().trim().min(1),
  /**
   * Omiti-lo reutiliza o token do negócio que já conectou o WhatsApp: é o mesmo
   * token que autoriza publicar no seu dataset, e pedi-lo outra vez só
   * consegue que alguém cole um segredo em um chat.
   */
  token: z.string().trim().min(1).optional(),
  /** A etapa que ESTE negócio considera "lead qualificado"; null desativa. */
  qualifiedStageId: z.string().trim().min(1).nullish(),
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();

  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  let token = body.data.token;
  if (!token) {
    const credentials = await getCredentialsByOrg(session.organizationId);
    if (!credentials) {
      return apiError(
        409,
        "sin_whatsapp",
        "Não há conexão do WhatsApp da qual reutilizar o token: cole um explícito"
      );
    }
    token = credentials.token;
  }

  const qualifiedStageId = body.data.qualifiedStageId ?? null;
  if (
    qualifiedStageId &&
    !(await stageBelongsToOrg(session.organizationId, qualifiedStageId))
  ) {
    return apiError(
      422,
      "etapa_invalida",
      "Essa etapa não pertence a este negócio"
    );
  }

  await saveCapiSettings({
    organizationId: session.organizationId,
    datasetId: body.data.datasetId,
    token,
    qualifiedStageId,
  });
  return Response.json({ ok: true });
});

export const DELETE = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  await deleteCapiSettings(session.organizationId);
  return Response.json({ ok: true });
});
