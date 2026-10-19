import { withAuth } from "@/lib/api";
import {
  atribucionDisabledResponse,
  atribucionEnabled,
} from "@/server/attribution/flag";
import { listConversionActivity } from "@/server/attribution/conversions";

export const dynamic = "force-dynamic";

/**
 * 016 — Atividade recente de conversões (somente leitura).
 *
 * Responde à única pergunta que importa quando se duvida disso: "está chegando
 * algo à Meta e, se não, por quê?". Sem ações: este endpoint jamais
 * escreve.
 */
export const GET = withAuth(async (session, req: Request) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  const raw = new URL(req.url).searchParams.get("limit");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  // Um limite fora da faixa é ajustado, não falha: é um painel, não um contrato
  // de paginação.
  const limit = Number.isFinite(parsed) ? parsed : undefined;
  const events = await listConversionActivity(session.organizationId, limit);
  return Response.json({ events });
});
