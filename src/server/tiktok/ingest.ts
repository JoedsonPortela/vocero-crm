import { TT_PREFIX } from "@/server/inbox/identity";
import { ingestInboundMessage } from "@/server/inbox/ingest";
import { getTiktokCredentialsByAccountRef } from "@/server/tiktok/credentials";
import { zernioSentAtSeconds, type ZernioEvent } from "@/server/zernio";

/**
 * 022 — Entrada do canal do TikTok.
 *
 * Uma única fonte (a Zernio), um evento plano com `account`. Normaliza-se aqui
 * e, dali em diante, roda o MESMO núcleo de ingestão dos demais canais:
 * contato, conversa, idempotência, barramento de eventos e turno do agente.
 *
 * O normalizador é uma função pura para poder testá-lo sem banco de dados:
 * o que se ingere e o que se descarta é a parte que mais facilmente quebra quando
 * o provedor muda um campo.
 */

/** Uma mensagem recebida já na forma que o núcleo entende. */
export type TiktokInbound = {
  /** `account.id` da Zernio: a chave de roteamento para a organização. */
  accountRef: string;
  /** Id do remetente: a identidade do contato (`tt:<id>`). */
  senderId: string;
  /** Id da mensagem na Zernio, para deduplicar. */
  messageId: string;
  text: string | null;
  /** text | image | video | audio | document | sticker | unsupported */
  type: string;
  /** Segundos desde epoch, como o núcleo consome. */
  timestamp: string;
  profileName: string | null;
  /** `conversationId` opaco da Zernio: é necessário para responder. */
  threadRef: string | null;
};

/**
 * Tipos de anexo → tipo de mensagem do CRM. O anexo não é baixado
 * (a Zernio o entrega como URL temporária): a mensagem entra com seu tipo para que
 * a caixa de entrada mostre o que chegou em vez de perdê-lo.
 */
const ATTACHMENT_TYPE: Record<string, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
  sticker: "sticker",
};

/** A plataforma do evento: a Zernio a envia na conta e na mensagem. */
export function zernioPlatform(evt: ZernioEvent | null): string {
  return (evt?.account?.platform ?? evt?.message?.platform ?? "").toLowerCase();
}

/**
 * Evento da Zernio → mensagem do TikTok, ou nada. O MESMO webhook traz as
 * demais plataformas conectadas a essa chave: sem o filtro acabaríamos
 * ingerindo uma DM do Instagram como se fosse do TikTok.
 */
export function normalizeZernioTiktokEvent(payload: unknown): TiktokInbound[] {
  const evt = payload as ZernioEvent | null;
  if (!evt || typeof evt !== "object") return [];

  if (zernioPlatform(evt) !== "tiktok") return [];
  if (evt.event !== "message.received") return [];
  // `message.sent` não chega aqui, mas um evento marcado como saída também não é
  // algo que o cliente disse.
  if (evt.message?.direction && evt.message.direction !== "incoming") return [];

  const accountRef = evt.account?.id ?? evt.account?.accountId;
  const senderId = evt.message?.sender?.id;
  const messageId = evt.message?.id;
  if (!accountRef || !senderId || !messageId) return [];

  const text =
    typeof evt.message?.text === "string" && evt.message.text.length > 0
      ? evt.message.text
      : null;
  const adjunto = evt.message?.attachments?.[0];
  const type = text
    ? "text"
    : adjunto
      ? (ATTACHMENT_TYPE[adjunto.type ?? ""] ?? "unsupported")
      : null;
  if (!type) return []; // nem texto nem anexo: não há nada a ingerir

  const sender = evt.message?.sender;
  return [
    {
      accountRef,
      senderId,
      messageId,
      text,
      type,
      timestamp: zernioSentAtSeconds(evt.message?.sentAt),
      profileName:
        sender?.name?.trim() ||
        (sender?.username ? `@${sender.username.replace(/^@/, "")}` : null),
      // Opaco por contrato: é guardado tal como está e não se interpreta.
      threadRef: evt.message?.conversationId ?? evt.conversation?.id ?? null,
    },
  ];
}

export async function processZernioTiktokEvent(payload: unknown): Promise<void> {
  for (const evt of normalizeZernioTiktokEvent(payload)) {
    const creds = await getTiktokCredentialsByAccountRef(evt.accountRef);
    if (!creds) {
      console.warn(
        `[tiktok] evento para una cuenta desconocida (${evt.accountRef}): ` +
          "guarda la conexión en Configuración → TikTok para recibir mensajes"
      );
      continue;
    }

    await ingestInboundMessage({
      organizationId: creds.organizationId,
      identity: {
        identity: `${TT_PREFIX}${evt.senderId}`,
        channel: "tiktok",
        phone: null,
        waUserId: null,
        profileName: evt.profileName,
      },
      // Prefixado para que jamais colida com um id de outro canal no
      // índice único de mensagens.
      waMessageId: `tt_${evt.messageId}`,
      type: evt.type,
      text: evt.text,
      timestamp: evt.timestamp,
      threadRef: evt.threadRef,
    });
  }
}
