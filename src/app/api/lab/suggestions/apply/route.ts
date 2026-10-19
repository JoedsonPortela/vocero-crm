import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

export const dynamic = "force-dynamic";

/**
 * Aplica uma sugestão do juiz com um clique: cria a entrada P/R na
 * knowledge base (FR-033). O front permite editá-la antes de salvar; aqui
 * chega o texto final.
 */
const bodySchema = z.object({
  caseId: z.string().min(1),
  hallazgoIndex: z.number().int().min(0),
  pregunta: z.string().trim().min(1).max(500),
  respuesta: z.string().trim().min(1).max(4000),
});

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const cases = await db
    .select({ id: schema.agentTestCase.id })
    .from(schema.agentTestCase)
    .where(
      scoped(
        schema.agentTestCase.organizationId,
        session.organizationId,
        eq(schema.agentTestCase.id, body.data.caseId)
      )
    )
    .limit(1);
  if (!cases[0]) return apiError(404, "not_found", "Caso no encontrado");

  const inserted = await db
    .insert(schema.kbEntry)
    .values({
      id: newId("kbEntry"),
      organizationId: session.organizationId,
      kind: "qa",
      question: body.data.pregunta,
      answer: body.data.respuesta,
    })
    .returning();
  return Response.json({ entry: inserted[0] }, { status: 201 });
});
