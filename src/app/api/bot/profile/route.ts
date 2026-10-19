import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { serializeBotProfile } from "@/server/bot/profile";

export const dynamic = "force-dynamic";

/**
 * Perfil do agente + knowledge base para um cérebro externo.
 * GET /api/bot/profile → {profile, kb, resources}. Sem cache: cada consulta
 * reflete o que o dono deixou na UI no momento (o TTL fica do lado do
 * bot, que é quem sabe de quanto em quanto tempo convém reler).
 */
export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "A instância ainda não tem organização");
  }

  const db = getDb();
  const profiles = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profiles[0];
  if (!profile) {
    // Condição esperada (instância sem perfil): o bot cai no seu brief local.
    return apiError(404, "no_profile", "A instância não tem perfil de agente");
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));

  return Response.json(serializeBotProfile(profile, kb));
}
