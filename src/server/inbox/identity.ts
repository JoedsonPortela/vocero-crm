import { and, eq, or } from "drizzle-orm";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { normalizeMx } from "@/lib/meta/client";
import type { WebhookMessage, WebhookValue } from "@/server/inbox/webhook";

/**
 * Identidade resiliente de contato (003).
 *
 * A Meta está migrando a identidade do WhatsApp de telefone para Business-Scoped
 * User IDs (BSUID): `wa_id`/`from` passam a ser opcionais e aparecem
 * `from_user_id` (mensagem) e `user_id` (contacts[]). Este módulo resolve a
 * identidade do remetente sem presumir telefone, e reconcilia para que um mesmo
 * humano não gere dois contatos.
 */

export const BSUID_PREFIX = "bsuid:";
/** 014: identidade do Instagram, análoga ao BSUID do WhatsApp. */
export const IG_PREFIX = "ig:";
/** 017: identidade do Messenger: o Page-Scoped ID (PSID) do remetente. */
export const FB_PREFIX = "fb:";
/** 022: identidade do TikTok: o id do remetente que a Zernio entrega. */
export const TT_PREFIX = "tt:";

// O tipo vive em lib/ porque a interface também o precisa; reexporta-se
// aqui para não tocar em quem já o importava deste módulo.
export type { Channel };

export type ResolvedIdentity = {
  /** Chave estável de resolução: telefone normalizado ou `bsuid:<id>`. */
  identity: string;
  /** 014: canal do contato. Ausente = whatsapp (compatibilidade). */
  channel?: Channel;
  phone: string | null;
  waUserId: string | null;
  profileName: string | null;
};

/**
 * Extrai a identidade utilizável de uma mensagem do webhook.
 * Devolve null se a mensagem não trouxer NENHUMA identidade (descarta-se com log,
 * jamais derruba o webhook).
 */
export function resolveIdentity(
  msg: WebhookMessage,
  contacts: WebhookValue["contacts"]
): ResolvedIdentity | null {
  const waUserId =
    msg.from_user_id ??
    contacts?.find((c) => c.wa_id != null && c.wa_id === msg.from)?.user_id ??
    contacts?.find((c) => c.user_id != null)?.user_id ??
    null;

  const profileName =
    contacts?.find((c) => c.wa_id != null && c.wa_id === msg.from)?.profile
      ?.name ??
    (waUserId
      ? contacts?.find((c) => c.user_id === waUserId)?.profile?.name
      : undefined) ??
    null;

  if (msg.from) {
    const phone = normalizeMx(msg.from);
    return { identity: phone, phone, waUserId, profileName };
  }
  if (waUserId) {
    return {
      identity: `${BSUID_PREFIX}${waUserId}`,
      phone: null,
      waUserId,
      profileName,
    };
  }
  return null;
}

/**
 * O contato de WhatsApp ao qual a ingestão atribuiria esta identidade, SEM
 * criá-lo: por `wa_identity`, por BSUID (em `wa_user_id` ou como identidade
 * `bsuid:`) ou por telefone. É A regra de reconciliação: a usam a ingestão
 * e o cérebro externo, para que os dois falem do mesmo humano.
 */
export async function findWhatsappContact(
  organizationId: string,
  resolved: ResolvedIdentity
) {
  const matchers = [eq(schema.contact.waIdentity, resolved.identity)];
  if (resolved.waUserId) {
    matchers.push(eq(schema.contact.waUserId, resolved.waUserId));
    matchers.push(
      eq(schema.contact.waIdentity, `${BSUID_PREFIX}${resolved.waUserId}`)
    );
  }
  if (resolved.phone) {
    matchers.push(eq(schema.contact.phone, resolved.phone));
  }

  const rows = await getDb()
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.channel, "whatsapp"),
        or(...matchers)
      )
    )
    .orderBy(schema.contact.createdAt)
    .limit(1);
  return rows[0];
}

/**
 * A identidade que envia um cérebro externo, lida como a lê a ingestão:
 * `bsuid:<id>` é um BSUID e o resto, um telefone (normalizado igual a
 * `from`). As de outros canais (`ig:`, `fb:`) não se reconciliam: null.
 */
export function parseIdentity(identity: string): ResolvedIdentity | null {
  if (
    identity.startsWith(IG_PREFIX) ||
    identity.startsWith(FB_PREFIX) ||
    identity.startsWith(TT_PREFIX)
  ) {
    return null;
  }
  if (identity.startsWith(BSUID_PREFIX)) {
    const waUserId = identity.slice(BSUID_PREFIX.length);
    if (!waUserId) return null;
    return { identity, phone: null, waUserId, profileName: null };
  }
  const phone = normalizeMx(identity);
  return { identity: phone, phone, waUserId: null, profileName: null };
}

/**
 * O contato de uma identidade para `/api/bot/*`. Primeiro a chave exata (de
 * qualquer canal); se não existir, a reconciliação da ingestão.
 *
 * O caso que a motiva: a Meta migra para BSUID. Quem escreveu primeiro COM
 * telefone tem `wa_identity` = telefone (estável para sempre) e seu BSUID em
 * `wa_user_id`; quando depois chega só com BSUID, a ingestão o reconcilia
 * com esse contato, mas o cérebro pergunta por `bsuid:<id>` e recebia 404: o
 * cliente ficava sem resposta.
 */
export async function findContactByIdentity(
  organizationId: string,
  identity: string
) {
  const rows = await getDb()
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.waIdentity, identity)
      )
    )
    .limit(1);
  if (rows[0]) return rows[0];
  const resolved = parseIdentity(identity);
  return resolved ? findWhatsappContact(organizationId, resolved) : undefined;
}

/**
 * Resolve ou cria o contato para uma identidade, reconciliando:
 * - Se chegarem telefone E BSUID, encontra o contato por qualquer um dos
 *   dois e adquire o sinal que lhe faltava (o `wa_identity` NÃO muda:
 *   é estável para sempre).
 * - Reativa contatos arquivados (o nome editado pelo operador
 *   é respeitado).
 */
export async function getOrCreateContactByIdentity(
  organizationId: string,
  resolved: ResolvedIdentity
) {
  const db = getDb();

  const channel: Channel = resolved.channel ?? "whatsapp";

  // 014/017: os canais da Meta (Instagram, Messenger) não compartilham espaço
  // de identidades com o WhatsApp. A reconciliação telefone<->BSUID é
  // exclusiva do WhatsApp, então neles a busca é direta por
  // identidade dentro do seu canal.
  if (channel !== "whatsapp") {
    const found = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.channel, channel),
          eq(schema.contact.waIdentity, resolved.identity)
        )
      )
      .limit(1);
    const existingIg = found[0];
    if (existingIg) {
      if (existingIg.archivedAt) {
        await db
          .update(schema.contact)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(schema.contact.id, existingIg.id));
        existingIg.archivedAt = null;
      }
      return { contact: existingIg, isNew: false };
    }
    const createdIg = await db
      .insert(schema.contact)
      .values({
        id: newId("contact"),
        organizationId,
        channel,
        waIdentity: resolved.identity,
        phone: null,
        waUserId: null,
        name: resolved.profileName?.trim() || channelFallback(channel),
      })
      .onConflictDoNothing({
        target: [
          schema.contact.organizationId,
          schema.contact.channel,
          schema.contact.waIdentity,
        ],
      })
      .returning();
    if (createdIg[0]) return { contact: createdIg[0], isNew: true };
    const racedIg = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.channel, channel),
          eq(schema.contact.waIdentity, resolved.identity)
        )
      )
      .limit(1);
    const contactIg = racedIg[0];
    if (!contactIg) throw new Error("contato não encontrado após o upsert");
    return { contact: contactIg, isNew: false };
  }

  const existing = await findWhatsappContact(organizationId, resolved);
  if (existing) {
    const patch: Partial<typeof schema.contact.$inferInsert> = {};
    if (resolved.waUserId && !existing.waUserId)
      patch.waUserId = resolved.waUserId;
    if (resolved.phone && !existing.phone) patch.phone = resolved.phone;
    /**
     * O nome do perfil é mantido atualizado (#51).
     *
     * Era atualizado SOMENTE ao criar o contato, então quem mudava seu
     * nome do WhatsApp continuava aparecendo com o antigo para sempre.
     *
     * Não se toca se foi escrito por uma pessoa: o operador que renomeou
     * alguém como "Juan - obra Polanco" não pode perder esse trabalho com a
     * próxima mensagem. Essa é toda a razão de existir o `nameSource`.
     */
    const delPerfil = resolved.profileName?.trim();
    if (
      delPerfil &&
      existing.nameSource === "perfil" &&
      delPerfil !== existing.name
    ) {
      patch.name = delPerfil;
    }
    if (existing.archivedAt) patch.archivedAt = null;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await db
        .update(schema.contact)
        .set(patch)
        .where(eq(schema.contact.id, existing.id));
      Object.assign(existing, patch);
    }
    return { contact: existing, isNew: false };
  }

  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      waIdentity: resolved.identity,
      phone: resolved.phone,
      waUserId: resolved.waUserId,
      name: resolved.profileName?.trim() || displayFallback(resolved),
    })
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (inserted[0]) return { contact: inserted[0], isNew: true };

  // Corrida: outra requisição o criou entre o SELECT e o INSERT.
  const raced = await db
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.waIdentity, resolved.identity)
      )
    )
    .limit(1);
  const contact = raced[0];
  if (!contact) throw new Error("contato não encontrado após o upsert");
  return { contact, isNew: false };
}

/** Nome de reserva quando não há nome de perfil: nunca o BSUID cru. */
function displayFallback(resolved: ResolvedIdentity): string {
  if (resolved.phone) return resolved.phone;
  return "Contacto de WhatsApp";
}

/**
 * Reserva para os canais cujo webhook não traz nome: nunca o IGSID nem o
 * PSID crus, que na caixa de entrada não dizem nada ao operador.
 */
function channelFallback(channel: Channel): string {
  return `Contacto de ${CHANNEL_LABEL[channel] ?? channel}`;
}
