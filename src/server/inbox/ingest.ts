import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { normalizeMx } from "@/lib/meta/client";
import { publish } from "@/server/events/bus";
import { getCredentialsByPhoneNumberId } from "@/server/whatsapp/credentials";
import { ensureAssetAvailable } from "@/server/whatsapp/media";
import type { Channel } from "@/lib/channels";
import type {
  WebhookMediaPayload,
  WebhookMessage,
  WebhookValue,
} from "@/server/inbox/webhook";
import {
  getOrCreateContactByIdentity,
  resolveIdentity,
  type ResolvedIdentity,
} from "@/server/inbox/identity";
import { applyStatusUpdate } from "@/server/inbox/status";
import {
  anuncioDeWhatsapp,
  type AnuncioDeOrigen,
} from "@/server/attribution/referral";
import { registrarAnuncioDeOrigen } from "@/server/attribution/store";
import { onLeadActivity } from "@/server/inbox/lead-activity";
import { maybeRunAgentTurn } from "@/server/ai/trigger";

/** Tipos de conteúdo suportados; o resto é ignorado sem erro. */
const SUPPORTED_TYPES = new Set([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
]);

/** #78 — Respostas de botão: entram como texto (ver `contenidoEntrante`). */
const BUTTON_REPLY_TYPES = new Set(["button", "interactive"]);

/**
 * #78 — O que escreveu o cliente, também quando o fez tocando um botão.
 *
 * Quando o cliente toca um botão de resposta rápida de um template, a Meta
 * envia `type: "button"` com o rótulo em `button.text`; quando toca um botão
 * ou uma linha de lista de uma mensagem interativa, `type: "interactive"` com o
 * rótulo em `interactive.button_reply.title` ou `interactive.list_reply.title`.
 * Para o negócio isso é um texto do cliente: entra na caixa de entrada, abre a
 * janela de 24 h e dispara o agente igual se tivesse digitado. Guarda-se como
 * `text` com o rótulo; o `payload`/`id` do botão não, porque a
 * mensagem não tem campo para metadados e o rótulo é o que o cliente viu e
 * escolheu. Devolve null se a resposta não trouxer nem rótulo nem identificador
 * (payload quebrado): quem chama a descarta com aviso, nunca derruba o webhook.
 */
export function contenidoEntrante(
  msg: WebhookMessage
): { type: string; text: string | null } | null {
  if (msg.type === "button") {
    const rotulo = limpio(msg.button?.text) ?? limpio(msg.button?.payload);
    return rotulo ? { type: "text", text: rotulo } : null;
  }
  if (msg.type === "interactive") {
    const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
    const rotulo = limpio(reply?.title) ?? limpio(reply?.id);
    return rotulo ? { type: "text", text: rotulo } : null;
  }
  return { type: msg.type, text: msg.text?.body ?? null };
}

function limpio(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

/** Tipos com arquivo binário no Graph (008). */
const BINARY_MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
] as const);

type MediaInput = {
  kind: (typeof schema.mediaAsset.$inferSelect)["kind"];
  waMediaId: string | null;
  mimeType: string | null;
  fileName: string | null;
  caption: string | null;
  payload: unknown;
  fetchStatus: "available" | "pending";
};

/**
 * 008 — Extrai o anexo de uma mensagem do webhook (recebida ou echo).
 * Tolerante: payload incompleto → null (a mensagem é mantida sem anexo).
 */
export function mediaInputFrom(msg: WebhookMessage): MediaInput | null {
  if (msg.type === "location" && msg.location) {
    const { latitude, longitude } = msg.location;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return null;
    }
    return {
      kind: "location",
      waMediaId: null,
      mimeType: null,
      fileName: null,
      caption: null,
      payload: msg.location,
      fetchStatus: "available",
    };
  }
  if (msg.type === "contacts" && Array.isArray(msg.contacts) && msg.contacts.length) {
    return {
      kind: "contacts",
      waMediaId: null,
      mimeType: null,
      fileName: null,
      caption: null,
      payload: msg.contacts,
      fetchStatus: "available",
    };
  }
  if ((BINARY_MEDIA_TYPES as Set<string>).has(msg.type)) {
    const media = msg[msg.type as "image" | "video" | "audio" | "document" | "sticker"] as
      | WebhookMediaPayload
      | undefined;
    if (!media?.id) return null;
    return {
      kind: msg.type as MediaInput["kind"],
      waMediaId: media.id,
      mimeType: media.mime_type ?? null,
      fileName: media.filename ?? null,
      caption: media.caption ?? null,
      payload: null,
      fetchStatus: "pending",
    };
  }
  return null;
}

/**
 * Cria o media_asset de uma mensagem recém-inserida e dispara o download em
 * segundo plano se houver binário. Jamais lança em direção ao webhook (FR-013).
 */
async function attachMediaAsset(
  organizationId: string,
  messageId: string,
  media: MediaInput
): Promise<typeof schema.mediaAsset.$inferSelect | null> {
  try {
    const db = getDb();
    const inserted = await db
      .insert(schema.mediaAsset)
      .values({
        id: newId("mediaAsset"),
        organizationId,
        kind: media.kind,
        waMediaId: media.waMediaId,
        mimeType: media.mimeType,
        fileName: media.fileName,
        caption: media.caption,
        payload: media.payload ?? null,
        fetchStatus: media.fetchStatus,
      })
      .returning();
    const asset = inserted[0];
    if (!asset) return null;
    await db
      .update(schema.message)
      .set({ mediaAssetId: asset.id })
      .where(eq(schema.message.id, messageId));
    if (asset.fetchStatus === "pending") {
      // Download in-process, sem bloquear a ingestão; o on-demand tenta de novo.
      void ensureAssetAvailable(organizationId, asset.id).catch(() => {});
    }
    return asset;
  } catch (err) {
    console.warn(`[media] no se pudo registrar el adjunto de ${messageId}:`, err);
    return null;
  }
}

/**
 * Criação/resolução de contato por telefone (cadastro manual / seeds). A ingestão
 * do webhook usa `getOrCreateContactByIdentity` (003) — este helper deriva a
 * identidade do telefone normalizado e delega para lá.
 */
export async function getOrCreateContact(
  organizationId: string,
  phone: string,
  name?: string | null
) {
  const normalized = normalizeMx(phone);
  return getOrCreateContactByIdentity(organizationId, {
    identity: normalized,
    phone: normalized,
    waUserId: null,
    profileName: name ?? null,
  });
}

export async function getOrCreateConversation(
  organizationId: string,
  contactId: string,
  opts?: { channel?: Channel; threadRef?: string | null }
) {
  const db = getDb();
  const inserted = await db
    .insert(schema.conversation)
    .values({
      id: newId("conversation"),
      organizationId,
      contactId,
      channel: opts?.channel ?? "whatsapp",
      channelThreadRef: opts?.threadRef ?? null,
      // 027: herda a pausa do contato no mesmo INSERT. Se fosse lida
      // antes, cada mensagem recebida pagaria mais uma consulta, e entre a
      // leitura e a inserção caberia o primeiro turno do agente.
      aiEnabled: sql<boolean>`coalesce((select not c.ai_paused from contact c where c.id = ${contactId}), true)`,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const rows = await db
    .select()
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.contactId, contactId),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new Error("conversación no encontrada tras upsert");
  // 014: o fio da plataforma pode aparecer depois (ou mudar); guarda-se
  // assim que se conhece, para poder responder.
  if (opts?.threadRef && existing.channelThreadRef !== opts.threadRef) {
    await db
      .update(schema.conversation)
      .set({ channelThreadRef: opts.threadRef, updatedAt: new Date() })
      .where(eq(schema.conversation.id, existing.id));
    existing.channelThreadRef = opts.threadRef;
  }
  return existing;
}

/**
 * Processa o `value` de uma mudança `messages` do webhook: mensagens recebidas
 * (idempotentes por wa_message_id) e atualizações de status.
 */
export async function processMessagesValue(value: WebhookValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const credentials = await getCredentialsByPhoneNumberId(phoneNumberId);
  if (!credentials) {
    // Caso típico: webhook/override configurado ANTES de salvar a conexão
    // no assistente — o evento chega, mas não há a qual organização roteá-lo.
    console.warn(
      `[webhook] evento para phone_number_id desconocido (${phoneNumberId}): ` +
        "guarda la conexión en Configuración → WhatsApp para recibir mensajes"
    );
    return;
  }

  const organizationId = credentials.organizationId;

  for (const status of value.statuses ?? []) {
    await applyStatusUpdate(organizationId, status);
  }

  for (const msg of value.messages ?? []) {
    if (!SUPPORTED_TYPES.has(msg.type) && !BUTTON_REPLY_TYPES.has(msg.type)) {
      continue; // reacciones, etc.: ignorar
    }
    const contenido = contenidoEntrante(msg);
    if (!contenido) {
      console.warn(
        `[webhook] respuesta de botón ${msg.id} (${msg.type}) sin rótulo ni identificador: descartada`
      );
      continue;
    }
    const resolved = resolveIdentity(msg, value.contacts);
    if (!resolved) {
      // Mensagem sem NENHUMA identidade utilizável (nem telefone nem BSUID):
      // registrar e descartar — jamais derrubar o webhook (003).
      console.warn(
        `[webhook] mensaje ${msg.id} sin identidad utilizable (sin from ni from_user_id): descartado`
      );
      continue;
    }
    await ingestInboundMessage({
      organizationId,
      identity: resolved,
      waMessageId: msg.id,
      type: contenido.type,
      text: contenido.text,
      timestamp: msg.timestamp,
      media: mediaInputFrom(msg),
      // 018: normalizado aqui, no adaptador do canal; a ingestão não sabe
      // de que forma a Meta o enviou.
      anuncio: anuncioDeWhatsapp(msg.referral),
    });
  }
}

/**
 * 008 — Echoes de coexistence (`smb_message_echoes`): mensagens que o dono enviou
 * À MÃO pelo app do WhatsApp Business do telefone. São registradas como saídas
 * `origin='manual'` e pausam a IA (decisão do dono, 2026-08-04). JAMAIS tocam a
 * janela de 24 h nem disparam o agente.
 */
export async function processEchoesValue(value: WebhookValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const credentials = await getCredentialsByPhoneNumberId(phoneNumberId);
  if (!credentials) {
    console.warn(
      `[webhook] echo para phone_number_id desconocido (${phoneNumberId}): descartado`
    );
    return;
  }

  // A Meta documenta `message_echoes`; parser tolerante a `messages` (R1).
  const echoes = value.message_echoes ?? value.messages ?? [];
  for (const echo of echoes) {
    if (!SUPPORTED_TYPES.has(echo.type)) continue;
    if (!echo.to) {
      console.warn(`[webhook] echo ${echo.id} sin destinatario: descartado`);
      continue;
    }
    try {
      await ingestManualEcho(credentials.organizationId, echo);
    } catch (err) {
      // Um echo malformado jamais derruba o webhook (caso de borda da especificação).
      console.error(`[webhook] error procesando echo ${echo.id}:`, err);
    }
  }
}

async function ingestManualEcho(
  organizationId: string,
  echo: WebhookMessage
): Promise<void> {
  const db = getDb();
  const identity = normalizeMx(echo.to!);

  const { contact } = await getOrCreateContactByIdentity(organizationId, {
    identity,
    phone: identity,
    waUserId: null,
    profileName: null,
  });
  const conversation = await getOrCreateConversation(organizationId, contact.id);

  const waTimestamp = toDate(echo.timestamp);

  // Idempotência rígida: as mensagens já registradas (ou echoes repetidos) não
  // duplicam efeitos — mesmo wa_message_id → sem inserção nem handoff extra.
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      waMessageId: echo.id,
      direction: "out",
      type: echo.type,
      text: echo.text?.body ?? null,
      status: "sent",
      origin: "manual",
      waTimestamp,
    })
    .onConflictDoNothing({ target: [schema.message.waMessageId] })
    .returning();
  const message = inserted[0];
  if (!message) return; // duplicado

  const mediaInput = mediaInputFrom(echo);
  const asset = mediaInput
    ? await attachMediaAsset(organizationId, message.id, mediaInput)
    : null;

  // Só lastMessageAt: uma mensagem do negócio NUNCA abre a janela de 24 h.
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: waTimestamp, updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));

  // Pausa automática da IA, idempotente e atômica (só se não houver handoff).
  const paused = await db
    .update(schema.conversation)
    .set({
      aiEnabled: false,
      handoffAt: new Date(),
      handoffReason: "manual_reply",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.conversation.id, conversation.id),
        sql`${schema.conversation.handoffAt} is null`
      )
    )
    .returning();
  if (paused[0]) {
    console.log(
      `[webhook] respuesta manual del dueño en ${conversation.id} — IA pausada (manual_reply)`
    );
  }

  publish(organizationId, {
    type: "message.new",
    data: {
      conversationId: conversation.id,
      message: serializeMessage(message, asset),
    },
  });
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });
}

export async function ingestInboundMessage(input: {
  organizationId: string;
  identity: ResolvedIdentity;
  waMessageId: string;
  type: string;
  text: string | null;
  timestamp: string;
  media?: MediaInput | null;
  /** 014: fio na plataforma de origem (Zernio); null no WhatsApp. */
  threadRef?: string | null;
  /** 016/018: o anúncio que abriu a conversa, já normalizado pelo canal. */
  anuncio?: AnuncioDeOrigen | null;
}): Promise<void> {
  const db = getDb();
  const { organizationId } = input;

  const { contact } = await getOrCreateContactByIdentity(
    organizationId,
    input.identity
  );
  const conversation = await getOrCreateConversation(
    organizationId,
    contact.id,
    { channel: contact.channel, threadRef: input.threadRef ?? null }
  );

  // 016/018 — Se a mensagem vem de um anúncio, capturar sua origem ANTES do
  // dedup da mensagem: é idempotente por si mesmo (o primeiro anúncio vence) e
  // assim uma nova tentativa da Meta que chegue com o referral não a perde por
  // ter sido cortada antes no dedup. Sempre, desde 018: a caixa de entrada diz de
  // qual anúncio chegou cada pessoa; sem a bandeira ATRIBUCION guarda-se sem o
  // identificador de clique (decide `registrarAnuncioDeOrigen`). Se falhar,
  // a mensagem do cliente entra igual: o anúncio é contexto, a mensagem é
  // o que importa.
  if (input.anuncio) {
    try {
      await registrarAnuncioDeOrigen({
        organizationId,
        contactId: contact.id,
        conversationId: conversation.id,
        anuncio: input.anuncio,
      });
    } catch (err) {
      console.warn(
        `[atribucion] no se registró el anuncio de ${conversation.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const waTimestamp = toDate(input.timestamp);

  // Idempotência rígida: mesmo wa_message_id → sem efeitos adicionais.
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      waMessageId: input.waMessageId,
      direction: "in",
      type: input.type,
      text: input.text,
      status: "delivered",
      waTimestamp,
    })
    .onConflictDoNothing({ target: [schema.message.waMessageId] })
    .returning();
  const message = inserted[0];
  if (!message) return; // duplicado

  const asset = input.media
    ? await attachMediaAsset(organizationId, message.id, input.media)
    : null;

  await db
    .update(schema.conversation)
    .set({
      lastInboundAt: waTimestamp,
      lastMessageAt: waTimestamp,
      unreadCount: sql`${schema.conversation.unreadCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversation.id, conversation.id));

  await onLeadActivity(organizationId, contact.id, waTimestamp);

  publish(organizationId, {
    type: "message.new",
    data: {
      conversationId: conversation.id,
      message: serializeMessage(message, asset),
    },
  });
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });

  await maybeRunAgentTurn(conversation.id, organizationId, message.id);
}

function toDate(timestamp: string): Date {
  const n = Number(timestamp);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000);
  return new Date();
}

export function serializeMessage(
  m: typeof schema.message.$inferSelect,
  media: typeof schema.mediaAsset.$inferSelect | null = null
) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    text: m.text,
    status: m.status,
    /** Motivo da falha, já traduzido para algo acionável (`describeSendError`). */
    error: m.error,
    aiGenerated: m.aiGenerated,
    origin: m.origin,
    media: media
      ? {
          assetId: media.id,
          kind: media.kind,
          mimeType: media.mimeType,
          fileName: media.fileName,
          fileSize: media.fileSize,
          caption: media.caption,
          fetchStatus: media.fetchStatus,
          payload: media.payload,
        }
      : null,
    createdAt: (m.waTimestamp ?? m.createdAt).toISOString(),
  };
}
