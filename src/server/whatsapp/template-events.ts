import type { WebhookValue } from "@/server/inbox/webhook";
import { applyTemplateStatusEvent } from "@/server/whatsapp/templates";

/**
 * Evento `message_template_status_update` (chega em nível de WABA: é roteado por
 * entry.id). Idempotente: reaplicar o mesmo estado não tem efeitos.
 */
export async function processTemplateStatusValue(
  wabaId: string | null,
  value: WebhookValue
): Promise<void> {
  await applyTemplateStatusEvent(wabaId, value);
}
