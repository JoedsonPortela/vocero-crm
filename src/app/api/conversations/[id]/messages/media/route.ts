import { apiError, withAuth } from "@/lib/api";
import { getConversation } from "@/server/inbox/queries";
import { SendError, sendMediaMessage } from "@/server/inbox/send";
import { MediaValidationError } from "@/server/whatsapp/media";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const SEND_ERROR_STATUS: Record<SendError["code"], number> = {
  sandbox_violation: 403,
  not_connected: 409,
  reconnect_required: 409,
  window_closed: 409,
  message_limit: 409,
  text_too_long: 422,
  meta_error: 422,
  meta_unavailable: 503,
  upload_failed: 502,
};

/**
 * 008 — Envia um anexo de arquivo pela conversa (multipart):
 * `file` (binário, obrigatório) + `caption` (opcional). A validação de tipo e
 * tamanho acontece ANTES de tocar no Graph (413/415 com o limite na mensagem).
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const conv = await getConversation(session.organizationId, id);
  if (!conv) return apiError(404, "not_found", "Conversa não encontrada");

  const form = await req.formData().catch(() => null);
  if (!form) {
    return apiError(400, "invalid", "Se esperaba multipart/form-data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError(422, "invalid", "Falta o arquivo (campo `file`)");
  }
  const captionRaw = form.get("caption");
  const caption =
    typeof captionRaw === "string" && captionRaw.trim()
      ? captionRaw.trim().slice(0, 1024)
      : undefined;

  const data = Buffer.from(await file.arrayBuffer());

  try {
    const result = await sendMediaMessage({
      conversationId: id,
      organizationId: session.organizationId,
      file: {
        data,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name || undefined,
      },
      caption,
    });
    return Response.json({ messageId: result.messageId }, { status: 201 });
  } catch (err) {
    if (err instanceof MediaValidationError) {
      return apiError(
        err.code === "too_large" ? 413 : 415,
        err.code,
        err.message
      );
    }
    if (err instanceof SendError) {
      return apiError(SEND_ERROR_STATUS[err.code], err.code, err.message);
    }
    throw err;
  }
});
