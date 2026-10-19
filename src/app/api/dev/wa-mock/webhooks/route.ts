import { mockGuard } from "@/lib/dev-guard";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

/**
 * O que o CRM registrou na «Meta»: a inscrição de cada WABA (com o seu
 * override, se alguém definiu) e o override de webhook de cada número. Para
 * que um self-test confira que salvar a conexão deixou o webhook definido, e
 * que desconectar o removeu, sem olhar dentro do CRM.
 */
export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  const { wabaSubscriptions, phoneWebhooks } = getWaMockState();
  return Response.json({ wabaSubscriptions, phoneWebhooks });
}
