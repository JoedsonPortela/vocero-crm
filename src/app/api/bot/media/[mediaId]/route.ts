import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { downloadGraphMedia, MediaFetchError } from "@/server/whatsapp/media";

export const dynamic = "force-dynamic";

/** Limite para o bot (transcreve áudio/imagem; nunca documentos de 100 MB). */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * 006 (amendment 002) — Download de um anexo da Meta para o bot.
 * GET /api/bot/media/{mediaId} → binário + content-type.
 *
 * O token do WhatsApp NÃO sai do CRM: o bot pede aqui, jamais à Meta.
 * Fluxo Graph delegado ao helper compartilhado (008): src/server/whatsapp/media.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ mediaId: string }> }
) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "A instância ainda não tem organização");
  }
  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    return apiError(409, "no_connection", "O WhatsApp não está conectado");
  }

  const { mediaId } = await ctx.params;
  if (!/^[\w.-]{1,64}$/.test(mediaId)) {
    return apiError(422, "invalid", "mediaId inválido");
  }

  try {
    const { data, mimeType } = await downloadGraphMedia(
      creds.token,
      mediaId,
      MAX_MEDIA_BYTES
    );
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": mimeType ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof MediaFetchError) {
      if (err.message.includes("límite")) {
        return apiError(413, "too_large", "O anexo excede o limite de 16 MB");
      }
      return apiError(
        err.gone ? 404 : 502,
        "media_download_failed",
        err.message
      );
    }
    return apiError(502, "media_download_failed", "Não foi possível baixar o anexo");
  }
}
