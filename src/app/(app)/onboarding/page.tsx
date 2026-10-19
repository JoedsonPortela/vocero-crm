import { redirect } from "next/navigation";
import { OnboardingClient } from "@/components/onboarding/onboarding-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { canConfigure } from "@/lib/auth/roles";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { guideStatus } from "@/server/onboarding/guide";

export const dynamic = "force-dynamic";

/**
 * O guia é resolvido no servidor a cada visita: o dono vai para Agente ou
 * para WhatsApp, volta pelo menu e vê o seu progresso sem recarregar nada manualmente.
 */
export default async function OnboardingPage() {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  if (!canConfigure(session.role)) redirect("/inbox");
  const [guide, [profile]] = await Promise.all([
    guideStatus(session.organizationId),
    getDb()
      .select({ name: schema.agentProfile.name })
      .from(schema.agentProfile)
      .where(scoped(schema.agentProfile.organizationId, session.organizationId))
      .limit(1),
  ]);
  return (
    <OnboardingClient guide={guide} agentName={profile?.name?.trim() || null} />
  );
}
