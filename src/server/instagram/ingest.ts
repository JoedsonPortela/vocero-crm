import { IG_PREFIX } from "@/server/inbox/identity";
import { ingestInboundMessage } from "@/server/inbox/ingest";
import {
  getInstagramCredentialsByAccountRef,
  getInstagramCredentialsByIgUserId,
} from "@/server/instagram/credentials";
import { zernioSentAtSeconds, type ZernioEvent } from "@/server/zernio";

/**
 * 014 — Adaptadores de entrada do canal do Instagram.
 *
 * Duas fontes com formatos que não se parecem em nada: a Zernio envia um evento
 * plano e a Meta envia `entry[].messaging[]` no estilo Messenger. Cada uma é
 * normalizada aqui e, dali em diante, roda o MESMO núcleo de ingestão que já
 * resolve contato, conversa, idempotência e barramento de eventos.
 */

/**
 * 017: a verificação da assinatura vive em `server/zernio`, porque a compartilham
 * todos os canais que entram por essa API. Re-exporta-se para não tocar em
 * quem já a importava daqui.
 */
export { isValidZernioSignature } from "@/server/zernio";

export async function processZernioEvent(payload: unknown): Promise<void> {
  const evt = payload as ZernioEvent;

  // O mesmo webhook traz WhatsApp, Facebook e X se essas contas estiverem
  // conectadas: sem este filtro acabaríamos ingerindo outra plataforma como
  // se fossem DMs do Instagram.
  if (evt.account?.platform !== "instagram") return;
  if (evt.event !== "message.received") return;
  if (evt.message?.direction && evt.message.direction !== "incoming") return;

  const accountRef = evt.account?.id;
  if (!accountRef) return;

  const creds = await getInstagramCredentialsByAccountRef(accountRef);
  if (!creds) {
    console.warn(
      `[ig] evento para accountId desconocido (${accountRef}): ` +
        "guarda la conexion en Configuracion -> Instagram para recibir mensajes"
    );
    return;
  }
  if (creds.source !== "zernio") {
    // Defesa em profundidade: esta instância não fala com a Zernio, então um
    // payload com o seu formato não pode ser legítimo mesmo que chegue pela URL
    // correta. Sem isto, a única barreira contra formato alheio é a URL.
    console.warn(
      `[ig] payload de Zernio en una instancia configurada como '${creds.source}': descartado`
    );
    return;
  }

  const igsid = evt.message?.sender?.id;
  if (!igsid) {
    console.warn(`[ig] evento ${evt.id ?? "?"} sin sender.id: descartado`);
    return;
  }

  const text = evt.message?.text ?? null;
  // Id da Zernio, não o da plataforma (o payload traz os dois): é o
  // que se mantém entre reentregas, que é o que precisa ser colapsado.
  const zernioMessageId = evt.message?.id;
  if (!zernioMessageId) {
    console.warn(`[ig] evento ${evt.id ?? "?"} sin id de mensaje: descartado`);
    return;
  }

  await ingestInboundMessage({
    organizationId: creds.organizationId,
    identity: {
      identity: `${IG_PREFIX}${igsid}`,
      channel: "instagram",
      phone: null,
      waUserId: null,
      profileName:
        evt.message?.sender?.name ??
        (evt.message?.sender?.username
          ? `@${evt.message.sender.username}`
          : null),
    },
    // Prefixado para que jamais colida com um id de WhatsApp no
    // índice único de mensagens.
    waMessageId: `ig_${zernioMessageId}`,
    type: "text",
    text,
    timestamp: zernioSentAtSeconds(evt.message?.sentAt),
    threadRef: evt.message?.conversationId ?? null,
  });
}

type MetaIgPayload = {
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
      };
    }>;
  }>;
};

export async function processMetaInstagramPayload(
  payload: unknown
): Promise<void> {
  const body = payload as MetaIgPayload;
  if (body.object !== "instagram") return;

  for (const entry of body.entry ?? []) {
    const igUserId = entry.id;
    if (!igUserId) continue;

    const creds = await getInstagramCredentialsByIgUserId(igUserId);
    if (!creds) {
      console.warn(
        `[ig] evento para IG_ID desconocido (${igUserId}): ` +
          "guarda la conexion en Configuracion -> Instagram para recibir mensajes"
      );
      continue;
    }
    if (creds.source !== "meta") {
      // Idem: sem app própria da Meta, um payload com seu formato não pode vir
      // da Meta. Fecha a injeção em instâncias que só usam a Zernio, onde
      // META_APP_SECRET não existe e a assinatura não pode ser verificada.
      console.warn(
        `[ig] payload de Meta en una instancia configurada como '${creds.source}': descartado`
      );
      continue;
    }

    for (const m of entry.messaging ?? []) {
      // Os echos são mensagens que o dono enviou pelo aplicativo do Instagram.
      // Fora do escopo do 014: são ignoradas sem ruído.
      if (m.message?.is_echo) continue;

      const igsid = m.sender?.id;
      const mid = m.message?.mid;
      if (!igsid || !mid) continue;
      if (typeof m.message?.text !== "string") continue; // só texto (014)

      await ingestInboundMessage({
        organizationId: creds.organizationId,
        identity: {
          identity: `${IG_PREFIX}${igsid}`,
          channel: "instagram",
          phone: null,
          waUserId: null,
          // A Meta não envia nome nem usuário no webhook: fica o fallback
          // até que alguém edite o contato.
          profileName: null,
        },
        waMessageId: `ig_${mid}`,
        type: "text",
        text: m.message.text,
        timestamp: String(
          m.timestamp ? Math.floor(m.timestamp / 1000) : Math.floor(Date.now() / 1000)
        ),
        threadRef: null,
      });
    }
  }
}
