import { apiError, withAuth } from "@/lib/api";
import {
  syncTemplates,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

/**
 * Sincroniza os estados dos templates via Graph API (pull). Caminho universal para
 * o modo agência: os webhooks de templates não seguem o override de
 * callback (limitação da Meta documentada no README).
 */
export const POST = withAuth(async (session) => {
  try {
    const updated = await syncTemplates(session.organizationId);
    return Response.json({ ok: true, updated });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
