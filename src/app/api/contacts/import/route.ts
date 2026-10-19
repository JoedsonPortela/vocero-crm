import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { IMPORT_MAX_ROWS, prepareImport } from "@/lib/contact-import";
import { importContacts } from "@/server/contacts-import";

export const dynamic = "force-dynamic";

const importSchema = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string().max(200),
        phone: z.string().max(40),
      })
    )
    .min(1)
    .max(IMPORT_MAX_ROWS),
  /** O agente não responde a eles: quem atende é o dono. */
  aiPaused: z.boolean().optional(),
});

/**
 * Importação de contatos em lote (CSV lido no navegador).
 *
 * O navegador já validou para mostrar a prévia, mas aqui se valida
 * de novo com a MESMA função: o que chega pela rede não é confiável, e um
 * telefone sem código de país criaria um contato que nunca bate com quem
 * escrever depois.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, importSchema);
  if (!body.ok) return body.response;

  const { valid, problems } = prepareImport(body.data.contacts);
  if (valid.length === 0) {
    return apiError(
      422,
      "nothing_to_import",
      "Nenhuma linha traz um telefone válido com código do país"
    );
  }

  const result = await importContacts(session.organizationId, valid, {
    aiPaused: body.data.aiPaused ?? false,
  });
  return Response.json({ ...result, skipped: problems });
});
