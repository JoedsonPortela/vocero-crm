import { apiError, withAuth } from "@/lib/api";
import { PeriodError, periodFromRequest } from "@/server/analytics/period";
import { adsBlock } from "@/server/analytics/ads";

export const dynamic = "force-dynamic";

/**
 * 019 — De onde chegam: conversas, prospects e vendas por origem e por
 * anúncio. Só contagens: sem gasto, sem custo, sem retorno (spec 019, D1-D2).
 */
export const GET = withAuth(async (session, req: Request) => {
  try {
    const period = await periodFromRequest(session.organizationId, new URL(req.url));
    return Response.json(await adsBlock(session.organizationId, period));
  } catch (err) {
    if (err instanceof PeriodError) {
      return apiError(422, "invalid_period", err.message);
    }
    throw err;
  }
});
