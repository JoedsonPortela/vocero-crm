import { apiError, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { guideFrom } from "@/server/onboarding/guide";
import { onboardingStatus } from "@/server/onboarding/status";

export const dynamic = "force-dynamic";

/**
 * O que falta à instância para que o agente responda (issue #86): os
 * passos verificados e o guia que sai deles. Para quem pode configurar,
 * igual à tela. Ver `server/onboarding/`.
 */
export const GET = withAuth(async (session) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Somente o proprietário configura a instância");
  }
  const status = await onboardingStatus(session.organizationId);
  return Response.json(
    { ...status, guide: guideFrom(status) },
    { headers: { "Cache-Control": "no-store" } }
  );
});
