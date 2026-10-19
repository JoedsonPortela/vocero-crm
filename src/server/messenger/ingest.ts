import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { FB_PREFIX } from "@/server/inbox/identity";
import { ingestInboundMessage } from "@/server/inbox/ingest";
import {
  getMessengerCredentialsByAccountRef,
  getMessengerCredentialsByPageId,
} from "@/server/messenger/credentials";
import { fetchMessengerProfileName } from "@/server/messenger/send";
import { zernioSentAtSeconds, type ZernioEvent } from "@/server/zernio";

/**
 * 017 — Adaptadores de entrada do canal do Messenger.
 *
 * Duas fontes com formatos que não se parecem: a Meta envia as mensagens da
 * página com `object: "page"` e a forma `entry[].messaging[]`; a Zernio envia um
 * evento plano com `account`. Cada uma é normalizada aqui e, dali em diante,
 * roda o MESMO núcleo de ingestão que já resolve contato, conversa,
 * idempotência e barramento de eventos (SSE).
 *
 * Os normalizadores são funções puras para poder testá-los sem base de
 * dados: o que se ingere e o que se descarta (echos, confirmações, postbacks, outra
 * plataforma) é a parte que mais facilmente quebra quando o provedor muda um
 * campo.
 */

/** Uma mensagem recebida já na forma que o núcleo entende. */
export type MessengerInbound = {
  /** Chave de roteamento: a página (Meta) ou a conta da Zernio. */
  routeKey: string;
  /** Page-Scoped ID do remetente: a identidade do contato (`fb:<PSID>`). */
  psid: string;
  /** Id da mensagem na plataforma, para deduplicar. */
  messageId: string;
  text: string | null;
  /** Tipo para a caixa de entrada: text | image | video | audio | document | sticker | unsupported */
  type: string;
  /** Segundos desde epoch, como o núcleo consome. */
  timestamp: string;
  /** Nome do perfil se a fonte o entregar (a Zernio sim, a Meta não). */
  profileName: string | null;
  /** Thread na plataforma de origem: é necessário para responder pela Zernio. */
  threadRef: string | null;
};

type MetaPagePayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        attachments?: Array<{
          type?: string;
          payload?: { url?: string; sticker_id?: number };
        }>;
      };
      postback?: unknown;
      delivery?: unknown;
      read?: unknown;
    }>;
  }>;
};

/**
 * Tipos de anexo → tipo de mensagem do CRM. Na v1 o anexo não é
 * baixado (as duas fontes o entregam como URL temporária, não como id de mídia):
 * a mensagem entra com seu tipo para que a caixa de entrada mostre "📎 Imagem" em vez
 * de perder a mensagem, e o operador saiba que há algo para ver.
 */
const ATTACHMENT_TYPE: Record<string, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
  document: "document",
};

/** Plataformas com as quais a Zernio nomeia o Messenger. */
const ZERNIO_MESSENGER_PLATFORMS = new Set(["facebook", "messenger"]);

export function normalizeMetaPagePayload(payload: unknown): MessengerInbound[] {
  const body = payload as MetaPagePayload | null;
  if (!body || body.object !== "page") return [];

  const out: MessengerInbound[] = [];
  for (const entry of body.entry ?? []) {
    const pageId = entry.id;
    if (!pageId) continue;

    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      // Confirmações de entrega/leitura e postbacks não são mensagens: nada que
      // mostrar na caixa de entrada.
      if (!msg) continue;
      // Os echos são o que a página enviou da sua própria caixa de entrada do
      // Facebook. Fora do escopo da v1: são ignorados sem ruído.
      if (msg.is_echo) continue;

      const psid = m.sender?.id;
      const mid = msg.mid;
      if (!psid || !mid) continue;

      const text =
        typeof msg.text === "string" && msg.text.length > 0 ? msg.text : null;
      const type = resolveType(text, msg.attachments?.[0]);
      if (!type) continue; // nem texto nem anexo: não há nada a ingerir

      out.push({
        routeKey: pageId,
        psid,
        messageId: mid,
        text,
        type,
        timestamp: String(
          m.timestamp ? Math.floor(m.timestamp / 1000) : Math.floor(Date.now() / 1000)
        ),
        // A Meta não envia nome nem usuário no webhook: consulta-se à parte.
        profileName: null,
        threadRef: null,
      });
    }
  }
  return out;
}

/**
 * Evento da Zernio. O MESMO webhook traz Instagram, WhatsApp e X se essas
 * contas estiverem conectadas: sem o filtro de plataforma acabaríamos ingerindo
 * outro canal como se fossem mensagens da página.
 */
export function normalizeZernioEvent(payload: unknown): MessengerInbound[] {
  const evt = payload as ZernioEvent | null;
  if (!evt || typeof evt !== "object") return [];

  const platform = (evt.account?.platform ?? "").toLowerCase();
  if (!ZERNIO_MESSENGER_PLATFORMS.has(platform)) return [];
  if (evt.event !== "message.received") return [];
  if (evt.message?.direction && evt.message.direction !== "incoming") return [];

  const accountRef = evt.account?.id;
  const psid = evt.message?.sender?.id;
  const messageId = evt.message?.id;
  if (!accountRef || !psid || !messageId) return [];

  const text =
    typeof evt.message?.text === "string" && evt.message.text.length > 0
      ? evt.message.text
      : null;
  const type = resolveType(text, evt.message?.attachments?.[0]);
  if (!type) return [];

  const sender = evt.message?.sender;
  return [
    {
      routeKey: accountRef,
      psid,
      messageId,
      text,
      type,
      timestamp: zernioSentAtSeconds(evt.message?.sentAt),
      profileName:
        sender?.name?.trim() ||
        (sender?.username ? `@${sender.username}` : null),
      // Opaco por contrato: é guardado tal como está e não se interpreta. É o que
      // faz falta para responder pela Zernio.
      threadRef: evt.message?.conversationId ?? null,
    },
  ];
}

function resolveType(
  text: string | null,
  attachment: { type?: string; payload?: { sticker_id?: number } } | undefined
): string | null {
  if (text) return "text";
  if (!attachment) return null;
  if (attachment.payload?.sticker_id) return "sticker";
  return ATTACHMENT_TYPE[attachment.type ?? ""] ?? "unsupported";
}

async function contactExists(
  organizationId: string,
  identity: string
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.channel, "messenger"),
        eq(schema.contact.waIdentity, identity)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function processMetaPagePayload(payload: unknown): Promise<void> {
  await ingestAll(normalizeMetaPagePayload(payload), "meta");
}

export async function processZernioMessengerEvent(
  payload: unknown
): Promise<void> {
  await ingestAll(normalizeZernioEvent(payload), "zernio");
}

async function ingestAll(
  events: MessengerInbound[],
  source: "zernio" | "meta"
): Promise<void> {
  for (const evt of events) {
    const creds =
      source === "meta"
        ? await getMessengerCredentialsByPageId(evt.routeKey)
        : await getMessengerCredentialsByAccountRef(evt.routeKey);

    if (!creds) {
      console.warn(
        `[messenger] evento para una cuenta desconocida (${evt.routeKey}): ` +
          "guarda la conexión en Configuración → Messenger para recibir mensajes"
      );
      continue;
    }
    if (creds.source !== source) {
      // Defesa em profundidade: se esta instância não fala com essa fonte, um
      // payload com o seu formato não pode ser legítimo mesmo que chegue pela URL
      // correta. Sem isto, a única barreira contra formato alheio é a URL.
      console.warn(
        `[messenger] payload de ${source} en una instancia configurada como ` +
          `'${creds.source}': descartado`
      );
      continue;
    }

    const identity = `${FB_PREFIX}${evt.psid}`;
    // O nome é resolvido UMA vez, a primeira que se vê do PSID: depois o
    // contato já existe e o nome que tiver (ou o que o operador editou)
    // manda. Consultá-lo em cada mensagem seria uma viagem ao provedor por
    // linha.
    const profileName =
      evt.profileName ??
      ((await contactExists(creds.organizationId, identity))
        ? null
        : await fetchMessengerProfileName(creds, evt.psid));

    await ingestInboundMessage({
      organizationId: creds.organizationId,
      identity: {
        identity,
        channel: "messenger",
        phone: null,
        waUserId: null,
        profileName,
      },
      // Prefixado para que jamais colida com um id de WhatsApp nem de
      // Instagram no índice único de mensagens.
      waMessageId: `fb_${evt.messageId}`,
      type: evt.type,
      text: evt.text,
      timestamp: evt.timestamp,
      threadRef: evt.threadRef,
    });
  }
}
