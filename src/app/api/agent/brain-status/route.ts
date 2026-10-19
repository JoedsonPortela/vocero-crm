import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import { isAiConfiguredFor } from "@/lib/ai/provider";
import { isBotKeyConfigured } from "@/server/bot/auth";
import {
  botLastSeenAt,
  computeBrainStatus,
  getBrainHealth,
} from "@/server/bot/status";
import { estadoDelDespacho } from "@/server/dispatch/estado";

export const dynamic = "force-dynamic";

/**
 * «Quem responde aos seus clientes»: o agente incluído, o cérebro externo,
 * o despacho (021) e o aviso de dupla resposta. Ver `server/bot/status.ts`.
 */
export const GET = withAuth(async (session) => {
  const db = getDb();
  const [rows, health, aiConfigured, dispatch] = await Promise.all([
    db
      .select({ enabled: schema.agentProfile.enabled })
      .from(schema.agentProfile)
      .where(scoped(schema.agentProfile.organizationId, session.organizationId))
      .limit(1),
    getBrainHealth(getEnv().BRAIN_HEALTH_URL),
    isAiConfiguredFor(session.organizationId),
    estadoDelDespacho(session.organizationId),
  ]);
  const status = computeBrainStatus({
    aiConfigured,
    agentEnabled: rows[0]?.enabled ?? false,
    botKeyConfigured: isBotKeyConfigured(),
    lastSeenAt: botLastSeenAt(),
    health,
    dispatch,
    now: new Date(),
  });
  return Response.json(status, { headers: { "cache-control": "no-store" } });
});
