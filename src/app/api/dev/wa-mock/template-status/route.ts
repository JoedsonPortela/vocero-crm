import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { apiError, parseBody } from "@/lib/api";
import { getWaMockState } from "@/server/dev/wa-mock-state";
import {
  buildTemplateStatusPayload,
  deliverToWebhook,
} from "@/server/dev/wa-mock-inbound";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  wabaId: z.string().min(1),
  name: z.string().min(1),
  language: z.string().min(1),
  event: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
  /** A Meta reclassifica ao aprovar (UTILITY → MARKETING). Só lado "Meta". */
  category: z.string().optional(),
  /**
   * `false` = move só o painel simulado da Meta, sem entregar o webhook.
   * Reproduz o modo agência real, em que `message_template_status_update` vai
   * ao callback no nível do app e esta instância nunca o vê: o único caminho é
   * o pull de `POST /api/templates/sync`.
   */
  notify: z.boolean().optional(),
});

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  // Manter coerente o estado do "painel da Meta" simulado (para o sync).
  const state = getWaMockState();
  const tpl = state.templates.find(
    (t) => t.name === body.data.name && t.language === body.data.language
  );
  if (tpl) {
    tpl.status = body.data.event;
    if (body.data.category) tpl.category = body.data.category;
  }

  if (body.data.notify === false) {
    return Response.json({ delivered: false, metaStatus: body.data.event });
  }

  const payload = buildTemplateStatusPayload({
    ...body.data,
    templateId: tpl?.id,
  });
  const res = await deliverToWebhook(payload);
  return res.ok
    ? Response.json({ delivered: true })
    : apiError(502, "webhook_error", `El webhook respondió ${res.status}`);
}
