import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import { digitsOnly, normalizeText } from "@/lib/search";
import { serializeContact } from "@/server/contacts";
import { createLeadForContact } from "@/server/inbox/lead-activity";

export const dynamic = "force-dynamic";

/**
 * Busca tolerante em SQL, espelho de `matchesQuery` do cliente:
 * - nome sem acentos nem maiúsculas (`translate`, sem depender da
 *   extensão `unaccent`, que exigiria privilégios no BD);
 * - telefone por DÍGITOS, para poder digitá-lo como aparece ("+52 555 000…").
 */
const UNACCENT_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
const UNACCENT_TO = "aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC";

export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const stage = url.searchParams.get("stage")?.trim();
  const includeArchived = url.searchParams.get("archived") === "true";

  const db = getDb();

  // Etapa de cada contato em uma consulta à parte: uma subconsulta
  // correlacionada aqui colide com o `id` de `lead` ("column reference id is
  // ambiguous"), e um join duplicaria contatos com mais de um lead.
  const leadStages = await db
    .select({
      contactId: schema.lead.contactId,
      stageName: schema.pipelineStage.name,
      priority: schema.lead.priority,
    })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.pipelineStage.id, schema.lead.stageId)
    )
    .where(scoped(schema.lead.organizationId, session.organizationId));
  const stageByContact = new Map(
    leadStages.map((r) => [r.contactId, r.stageName])
  );
  const priorityByContact = new Map(
    leadStages.map((r) => [r.contactId, r.priority])
  );

  const qDigits = q ? digitsOnly(q) : "";
  // O padrão viaja normalizado como a coluna, e com os curingas do
  // LIKE escapados para que um "%" digitado não liste tudo.
  const qLike = q ? normalizeText(q).replace(/[\\%_]/g, "\\$&") : "";
  const search =
    q && q.length > 0
      ? or(
          sql`lower(translate(${schema.contact.name}, ${UNACCENT_FROM}, ${UNACCENT_TO}))
              like ${`%${qLike}%`}`,
          // Um dígito solto varreria o diretório inteiro: mínimo 3.
          qDigits.length >= 3
            ? sql`regexp_replace(coalesce(${schema.contact.phone}, ''), '\\D', '', 'g')
                  like ${`%${qDigits}%`}`
            : undefined
        )
      : undefined;

  // O filtro de etapa é aplicado ANTES do limite: senão, um contato da
  // etapa buscada poderia ficar de fora pelo corte de 200.
  const stageContactIds = stage
    ? leadStages.filter((r) => r.stageName === stage).map((r) => r.contactId)
    : null;
  if (stageContactIds?.length === 0) return Response.json({ contacts: [] });

  const rows = await db
    .select()
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        session.organizationId,
        search,
        stageContactIds ? inArray(schema.contact.id, stageContactIds) : undefined
      )
    )
    .orderBy(desc(schema.contact.updatedAt))
    .limit(200);

  const contacts = rows
    .filter((c) => includeArchived || !c.archivedAt)
    .map((c) =>
      serializeContact(
        c,
        stageByContact.get(c.id) ?? null,
        priorityByContact.get(c.id) ?? null
      )
    );
  return Response.json({ contacts });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /**
   * EXIGE código de país. Um número local criaria um contato que jamais casaria
   * com as mensagens recebidas —a Meta sempre envia a identidade completa— e o
   * dono acabaria com duas fichas da mesma pessoa. Não se assume um país:
   * dez dígitos são válidos em vários, e assumir errado produz um número
   * silenciosamente equivocado.
   */
  phone: z
    .string()
    .trim()
    .regex(/^\d{7,15}$/, "Telefone em dígitos, com código do país (ex.: 5215512345678)"),
  notes: z.string().max(4000).optional(),
  source: z.enum(["anuncio", "organico", "referido", "conocido", "otro"]).optional(),
  /** Etapa inicial do lead; se não vier, a primeira aberta do quadro. */
  stageId: z.string().min(1).optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  // 003: a identidade WhatsApp é derivada do telefone normalizado.
  const phone = normalizeMx(body.data.phone);
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId: session.organizationId,
      name: body.data.name,
      phone,
      waIdentity: phone,
      notes: body.data.notes ?? null,
      source: body.data.source ?? null,
    })
    // O canal entra no target porque entra no índice único desde 014
    // (`contact_org_channel_identity_uq`). O Postgres exige que o ON CONFLICT
    // cite EXATAMENTE as colunas de um índice existente: sem `channel`,
    // o cadastro manual falha com "no unique or exclusion constraint matching".
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (!inserted[0]) {
    return apiError(409, "duplicate", "Já existe um contato com esse telefone");
  }

  // E o seu lead: um contato sem lead é invisível no Pipeline, que é a
  // tela onde se trabalha o funil. Cadastrar alguém e não vê-lo ali
  // é metade da função.
  const lead = await createLeadForContact({
    organizationId: session.organizationId,
    contactId: inserted[0].id,
    stageId: body.data.stageId,
    source: "dueno",
    actorUserId: session.userId,
  });
  if (!lead) {
    return apiError(
      422,
      "no_stage",
      "O funil não tem etapas abertas para colocar o prospect"
    );
  }

  return Response.json(
    { contact: serializeContact(inserted[0]), lead: { id: lead.id } },
    { status: 201 }
  );
});
