import { apiError, withAuth } from "@/lib/api";
import { getDb } from "@/lib/db";
import { isDomainEmpty, seedDemo } from "@/server/seed/demo";

export const dynamic = "force-dynamic";

/**
 * Carga el negocio demo (FR-075). Solo con la BD de dominio vacía — la
 * versión por script (`pnpm seed:demo`) permite recargar con --force.
 */
export const POST = withAuth(async (session) => {
  const db = getDb();
  const empty = await isDomainEmpty(db, session.organizationId);
  if (!empty) {
    return apiError(
      409,
      "not_empty",
      "Já há dados na organização; a demonstração só é carregada com a base vazia"
    );
  }
  const result = await seedDemo(db, session.organizationId);
  return Response.json({ ok: true, ...result });
});
