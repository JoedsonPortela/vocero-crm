import { eq } from "drizzle-orm";
import { apiError, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  ensureAssetAvailable,
  readMediaFile,
} from "@/server/whatsapp/media";
import { mediaResponseHeaders } from "@/server/whatsapp/media-headers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ assetId: string }> };

/**
 * 008 — Serve o binário de um anexo a partir do volume local. Só com
 * sessão e dentro da organização (um asset alheio responde 404: nunca se
 * revela a existência entre tenants). Se o arquivo ainda não foi baixado,
 * tenta sob demanda no Graph; se a Meta já o expirou → 410.
 */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { assetId } = await ctx.params;
  if (!/^[\w.-]{1,64}$/.test(assetId)) {
    return apiError(422, "invalid", "assetId inválido");
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mediaAsset)
    .where(
      scoped(
        schema.mediaAsset.organizationId,
        session.organizationId,
        eq(schema.mediaAsset.id, assetId)
      )
    )
    .limit(1);
  let asset = rows[0];
  if (!asset) return apiError(404, "not_found", "Adjunto no encontrado");

  if (asset.kind === "location" || asset.kind === "contacts") {
    // Sem binário: o payload vem no DTO da mensagem.
    return apiError(404, "no_binary", "Este adjunto no tiene archivo");
  }

  if (asset.fetchStatus !== "available") {
    // Sob demanda: tenta o download no momento (pending ou failed).
    asset = (await ensureAssetAvailable(session.organizationId, assetId)) ?? asset;
  }
  if (asset.fetchStatus !== "available" || !asset.storagePath) {
    return apiError(
      410,
      "gone",
      "O conteúdo não está mais disponível (expirou no WhatsApp antes de poder ser copiado)"
    );
  }

  try {
    const data = await readMediaFile(session.organizationId, assetId);
    // #78: nosniff + CSP sandbox sempre; inline só para o que é visualizável.
    return new Response(new Uint8Array(data), {
      headers: mediaResponseHeaders(asset, data.byteLength),
    });
  } catch {
    return apiError(410, "gone", "O arquivo do anexo não está no volume");
  }
});
