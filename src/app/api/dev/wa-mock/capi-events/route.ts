import { mockGuard } from "@/lib/dev-guard";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

/**
 * 016 — O que o CRM enviou para a Conversions API do mock. Existe para que
 * o self-test possa afirmar sobre a FORMA do evento (nome, ctwa_clid,
 * `custom_data`, valor em unidades) e não só sobre "não houve erro".
 */
export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  return Response.json({ capiEvents: getWaMockState().capiEvents });
}

export async function DELETE() {
  const guard = mockGuard();
  if (guard) return guard;
  getWaMockState().capiEvents.length = 0;
  return Response.json({ cleared: true });
}
