import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { destinatarioMeta, type Destinatario } from "@/lib/meta/destinatario";
import { publish } from "@/server/events/bus";
import {
  getCredentialsByOrg,
  markReconnectRequired,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { isWindowOpen, replyWindow } from "@/server/inbox/window";
import { plainSocialText } from "@/lib/social-text";
import { IG_PREFIX } from "@/server/inbox/identity";
import {
  getInstagramCredentialsByOrg,
  markInstagramReconnectRequired,
  type InstagramCredentials,
} from "@/server/instagram/credentials";
import { sendInstagramText } from "@/server/instagram/send";
import { FB_PREFIX } from "@/server/inbox/identity";
import {
  getMessengerCredentialsByOrg,
  markMessengerReconnectRequired,
  type MessengerCredentials,
} from "@/server/messenger/credentials";
import { sendMessengerText } from "@/server/messenger/send";
import { TT_PREFIX } from "@/server/inbox/identity";
import {
  getTiktokCredentialsByOrg,
  markTiktokReconnectRequired,
  type TiktokCredentials,
} from "@/server/tiktok/credentials";
import { sendTiktokText } from "@/server/tiktok/send";
import {
  cabeOtroMensaje,
  salientesDesdeElUltimoEntrante,
} from "@/server/inbox/outbound-cap";
import {
  capabilitiesFor,
  outboundLimitMessage,
  textFits,
  textLimitMessage,
  windowClosedMessage,
  windowMsFor,
  aiWindowClosedMessage,
} from "@/server/channels/capabilities";
import { isChannelEnabled } from "@/server/channels/enabled";
import { serializeMessage } from "@/server/inbox/ingest";
import {
  saveMediaFile,
  uploadGraphMedia,
  validateOutgoing,
} from "@/server/whatsapp/media";

/** Erro tipado do envio; `code` mapeia para HTTP na camada de API. */
export class SendError extends Error {
  code:
    | "sandbox_violation"
    | "not_connected"
    | "reconnect_required"
    | "window_closed"
    /** 022: o canal não aceita mais mensagens até o cliente escrever. */
    | "message_limit"
    /** 022: o texto não cabe no canal dessa conversa. */
    | "text_too_long"
    | "meta_error"
    | "meta_unavailable"
    | "upload_failed";
  /** 008: presente quando a falha ocorreu DEPOIS de persistir a mensagem (failed). */
  messageId?: string;

  constructor(code: SendError["code"], message: string) {
    super(message);
    this.name = "SendError";
    this.code = code;
  }
}

type SendResult = { messageId: string };

type SendTarget = {
  conversation: typeof schema.conversation.$inferSelect;
  /** null quando o destino não é WhatsApp (014). */
  credentials: Credentials | null;
  /** O destinatário na forma que a Meta espera: `to` ou `recipient`. */
  destinatario: Destinatario;
  /** O identificador puro, para o que não monta um payload do Graph. */
  recipient: string;
  /** 014: presente só em conversas do Instagram. */
  instagram?: InstagramCredentials;
  /** 017: presente só em conversas do Messenger. */
  messenger?: MessengerCredentials;
  /** 022: presente só em conversas do TikTok. */
  tiktok?: TiktokCredentials;
  /**
   * 024: o envio sai com a etiqueta de agente humano. Quem decide isso é o
   * pré-voo (`assertReplyWindow`), não cada canal por conta própria.
   */
  humanAgentTag?: boolean;
};

/**
 * 024 — A porta da janela para os canais com extensão humana
 * (Instagram e Messenger). Devolve se o envio leva a etiqueta.
 *
 * - Dentro da janela normal escreve qualquer um.
 * - Depois, e até o teto da extensão, só uma pessoa, com a
 *   etiqueta. A IA não: a Meta reserva essa etiqueta a agentes humanos.
 * - Passado o teto (ou sem nenhuma mensagem do cliente) ninguém escreve, e isso
 *   é dito aqui em vez de deixar que a plataforma rejeite o envio com um erro
 *   que o operador não entende.
 */
function assertReplyWindow(
  conversation: SendTarget["conversation"],
  aiGenerated: boolean
): boolean {
  const w = replyWindow(conversation.channel, conversation.lastInboundAt);
  if (!w.operatorOpen) {
    throw new SendError("window_closed", windowClosedMessage(conversation.channel));
  }
  if (aiGenerated && !w.standardOpen) {
    throw new SendError("window_closed", aiWindowClosedMessage(conversation.channel));
  }
  return w.humanAgentTag;
}

/**
 * Pré-voo comum a todo envio pela conversa (008): existência +
 * tenant, sandbox do Laboratório (ASSERÇÃO DURA, FR-031: jamais toca a API
 * real), janela de 24 h, credenciais e destinatário.
 */
async function prepareSend(
  conversationId: string,
  organizationId: string,
  /** 024: quem escreve decide se pode usar a extensão humana. */
  aiGenerated: boolean = false
): Promise<SendTarget> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.conversation.organizationId !== organizationId) {
    throw new SendError("meta_error", "Conversa não encontrada");
  }

  if (row.conversation.isTest) {
    throw new SendError(
      "sandbox_violation",
      "Conversa de teste do Laboratório: o envio real é proibido"
    );
  }

  // 014: o Instagram tem seu próprio transporte, sua própria janela e NÃO tem
  // templates. Resolve-se antes das credenciais do WhatsApp para não
  // exigir de uma instância só-Instagram um número conectado.
  if (row.conversation.channel === "instagram") {
    // Uma conversa de um canal desligado pode existir (foi desligado depois de
    // recebê-la): falha claro em vez de tentar um transporte que não se aplica.
    if (!isChannelEnabled("instagram")) {
      throw new SendError(
        "not_connected",
        "O canal do Instagram está desativado nesta instância"
      );
    }
    const igCreds = await getInstagramCredentialsByOrg(organizationId);
    if (!igCreds) {
      throw new SendError(
        "not_connected",
        "Não há conta do Instagram conectada"
      );
    }
    if (igCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "O token do Instagram expirou: reconecte a conta em Configurações"
      );
    }
    const igRecipient = row.contact.waIdentity.startsWith(IG_PREFIX)
      ? row.contact.waIdentity.slice(IG_PREFIX.length)
      : row.contact.waIdentity;
    const humanAgentTag = assertReplyWindow(row.conversation, aiGenerated);
    return {
      humanAgentTag,
      conversation: row.conversation,
      credentials: null,
      // O Instagram não passa pela Graph API do WhatsApp; o campo existe para
      // cumprir o tipo e seu caminho de envio não o olha.
      destinatario: { to: igRecipient },
      recipient: igRecipient,
      instagram: igCreds,
    };
  }

  // 017: o Messenger, mesmo tratamento do Instagram: transporte próprio, janela
  // própria (com etiqueta fora dela) e sem templates.
  if (row.conversation.channel === "messenger") {
    if (!isChannelEnabled("messenger")) {
      throw new SendError(
        "not_connected",
        "O canal do Messenger está desativado nesta instância"
      );
    }
    const fbCreds = await getMessengerCredentialsByOrg(organizationId);
    if (!fbCreds) {
      throw new SendError(
        "not_connected",
        "Não há página do Facebook conectada"
      );
    }
    if (fbCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "O token da página expirou: reconecte o Messenger em Configurações"
      );
    }
    const fbRecipient = row.contact.waIdentity.startsWith(FB_PREFIX)
      ? row.contact.waIdentity.slice(FB_PREFIX.length)
      : row.contact.waIdentity;
    const humanAgentTag = assertReplyWindow(row.conversation, aiGenerated);
    return {
      humanAgentTag,
      conversation: row.conversation,
      credentials: null,
      // O Messenger também não passa pela Graph API do WhatsApp.
      destinatario: { to: fbRecipient },
      recipient: fbRecipient,
      messenger: fbCreds,
    };
  }

  // 022: TikTok. Transporte próprio (Zernio) e os dois limites que nenhum outro
  // canal tem: a janela não se pode reabrir, e admite um número contado de
  // mensagens desde a última mensagem recebida. Os dois se perguntam às capacidades
  // e se verificam AQUI, antes de chamar ninguém: o envio que a plataforma
  // rejeitaria não sai, e falha com um motivo que o operador entende.
  if (row.conversation.channel === "tiktok") {
    if (!isChannelEnabled("tiktok")) {
      throw new SendError(
        "not_connected",
        "El canal de TikTok está desactivado en esta instancia"
      );
    }
    const ttCreds = await getTiktokCredentialsByOrg(organizationId);
    if (!ttCreds) {
      throw new SendError("not_connected", "No hay cuenta de TikTok conectada");
    }
    if (ttCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "La llave de Zernio dejó de servir: reconecta TikTok en Configuración"
      );
    }
    if (
      !isWindowOpen(
        row.conversation.lastInboundAt,
        new Date(),
        windowMsFor("tiktok")
      )
    ) {
      throw new SendError("window_closed", windowClosedMessage("tiktok"));
    }
    const enviados = await salientesDesdeElUltimoEntrante(
      organizationId,
      conversationId
    );
    if (!cabeOtroMensaje("tiktok", enviados)) {
      throw new SendError("message_limit", outboundLimitMessage("tiktok"));
    }
    const ttRecipient = row.contact.waIdentity.startsWith(TT_PREFIX)
      ? row.contact.waIdentity.slice(TT_PREFIX.length)
      : row.contact.waIdentity;
    return {
      conversation: row.conversation,
      credentials: null,
      // O TikTok também não passa pela Graph API do WhatsApp.
      destinatario: { to: ttRecipient },
      recipient: ttRecipient,
      tiktok: ttCreds,
    };
  }

  // O núcleo não decide a política: a consulta. O WhatsApp exige template
  // fora da janela; o Instagram marca a etiqueta e segue; outro canal poderia não ter
  // janela nenhuma.
  const caps = capabilitiesFor(row.conversation.channel);
  if (
    caps.windowMs !== null &&
    caps.outsideWindow === "template" &&
    !isWindowOpen(row.conversation.lastInboundAt)
  ) {
    throw new SendError(
      "window_closed",
      windowClosedMessage(row.conversation.channel)
    );
  }

  const credentials = await getCredentialsByOrg(organizationId);
  if (!credentials) {
    throw new SendError("not_connected", "No hay número de WhatsApp conectado");
  }
  if (credentials.status === "reconnect_required") {
    throw new SendError(
      "reconnect_required",
      "El token de WhatsApp expiró: reconecta el número en Configuración"
    );
  }

  /**
   * 003 — O destinatário, no campo que a Meta espera para cada forma.
   *
   * Um telefone vai em `to`; um BSUID vai em `recipient` com
   * `recipient_type: "individual"`. Mandava-se o BSUID em `to` e a Meta
   * respondia 131026, que na caixa de entrada se lê como se o número do cliente
   * não existisse.
   */
  const destinatario = destinatarioMeta(
    row.contact.phone ? normalizeRecipient(row.contact.phone) : null,
    row.contact.waUserId
  );
  const recipient = destinatario
    ? "to" in destinatario
      ? destinatario.to
      : destinatario.recipient
    : null;
  if (!destinatario || !recipient) {
    throw new SendError(
      "meta_error",
      "El contacto no tiene teléfono ni identidad de WhatsApp utilizable"
    );
  }

  return { conversation: row.conversation, credentials, destinatario, recipient };
}

async function persistOutbound(input: {
  organizationId: string;
  conversationId: string;
  waMessageId: string | null;
  type: string;
  text: string | null;
  /**
   * 014: 'sent' existe porque nem todos os canais confirmam por webhook.
   * O WhatsApp entra como 'pending' e avança com os `statuses` da Meta;
   * o Instagram não manda esse evento salvo que se inscreva à parte, então a
   * aceitação da plataforma É a confirmação. Sem isto a mensagem fica
   * com o relógio para sempre mesmo que já tenha sido entregue.
   */
  status: "pending" | "sent" | "failed";
  error?: string | null;
  aiGenerated?: boolean;
  origin: "ai" | "operator";
  mediaAssetId?: string | null;
  media?: typeof schema.mediaAsset.$inferSelect | null;
}): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: input.waMessageId,
      direction: "out",
      type: input.type,
      text: input.text,
      status: input.status,
      error: input.error ?? null,
      aiGenerated: input.aiGenerated ?? false,
      origin: input.origin,
      mediaAssetId: input.mediaAssetId ?? null,
    })
    .returning();
  const message = inserted[0]!;

  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, input.conversationId));

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: input.conversationId,
      message: serializeMessage(message, input.media ?? null),
    },
  });

  return message.id;
}

/** Envia uma mensagem de texto livre pelo WhatsApp. */
export async function sendText(input: {
  conversationId: string;
  organizationId: string;
  text: string;
  aiGenerated?: boolean;
}): Promise<SendResult> {
  const target = await prepareSend(
    input.conversationId,
    input.organizationId,
    input.aiGenerated ?? false
  );
  const { credentials } = target;
  const canal = target.conversation.channel;

  // 024: a IA escreve com formato de WhatsApp (e às vezes Markdown). Num
  // canal que não o desenha tiram-se as marcas ANTES de medir, enviar e
  // guardar: o que fica no fio é o que o cliente leu. O que escreve
  // uma pessoa não se toca.
  const text =
    input.aiGenerated && capabilitiesFor(canal).textFormat === "plain"
      ? plainSocialText(input.text)
      : input.text;

  // 022: o limite de tamanho é do canal. O WhatsApp e o TikTok o declaram em
  // caracteres e se verifica aqui, antes de chamar ninguém; o Instagram e
  // o Messenger (em bytes) o seguem verificando no seu próprio caminho.
  if (capabilitiesFor(canal).maxTextChars !== null && !textFits(canal, text)) {
    throw new SendError("text_too_long", textLimitMessage(canal));
  }

  const waMessageId = target.instagram
    ? await callInstagramSend(target, text)
    : target.messenger
      ? await callMessengerSend(target, text)
      : target.tiktok
        ? await callTiktokSend(target, text)
        : await callGraphSend(credentials!, {
          messaging_product: "whatsapp",
          ...target.destinatario,
          type: "text",
          text: { body: text },
        });

  const messageId = await persistOutbound({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    waMessageId,
    type: "text",
    text,
    // Um canal sem confirmações de entrega confirma ao aceitar; um com confirmações
    // avança depois por webhook. Sem esta distinção a mensagem fica
    // com o relógio para sempre.
    status: capabilitiesFor(target.conversation.channel).deliveryReceipts
      ? "pending"
      : "sent",
    aiGenerated: input.aiGenerated,
    origin: input.aiGenerated ? "ai" : "operator",
  });

  return { messageId };
}

/**
 * 008 — Envia um anexo de arquivo (imagem/vídeo/áudio/documento).
 * O arquivo fica ANTES no volume local (fonte durável da prévia);
 * se o Graph falhar depois disso, a mensagem é persistida como `failed` (visível no
 * fio, nunca se perde em silêncio) e o SendError leva `messageId`.
 */
export async function sendMediaMessage(input: {
  conversationId: string;
  organizationId: string;
  file: { data: Buffer; mimeType: string; fileName?: string };
  caption?: string;
}): Promise<SendResult> {
  // Validação prévia (FR-007): tipo e tamanho antes de tocar o disco ou a rede.
  const kind = validateOutgoing(input.file.mimeType, input.file.data.byteLength);

  const target = await prepareSend(input.conversationId, input.organizationId);
  const { credentials } = target;
  const sendCaps = capabilitiesFor(target.conversation.channel);
  if (!sendCaps.outboundMedia) {
    throw new SendError(
      "meta_error",
      `Todavía no se pueden enviar adjuntos por ${sendCaps.label}; manda el texto`
    );
  }

  const db = getDb();
  const assetId = newId("mediaAsset");
  const storagePath = await saveMediaFile(
    input.organizationId,
    assetId,
    input.file.data
  );
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: assetId,
      organizationId: input.organizationId,
      kind,
      mimeType: input.file.mimeType,
      fileName: input.file.fileName ?? null,
      fileSize: input.file.data.byteLength,
      caption: input.caption ?? null,
      storagePath,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  try {
    const waMediaId = await uploadGraphMedia(credentials!, input.file);
    await db
      .update(schema.mediaAsset)
      .set({ waMediaId, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));

    const mediaPayload: Record<string, unknown> = { id: waMediaId };
    if (input.caption && kind !== "audio") mediaPayload.caption = input.caption;
    if (kind === "document" && input.file.fileName) {
      mediaPayload.filename = input.file.fileName;
    }
    const waMessageId = await callGraphSend(credentials!, {
      messaging_product: "whatsapp",
      ...target.destinatario,
      type: kind,
      [kind]: mediaPayload,
    });

    const messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId,
      type: kind,
      text: null,
      status: "pending",
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    return { messageId };
  } catch (err) {
    let sendErr: SendError;
    if (err instanceof SendError) {
      sendErr = err;
    } else if (err instanceof MetaApiError && err.isAuthError) {
      // Mesmo critério do texto: SOMENTE 401/código 190 (correção de 2026-08-04).
      await markReconnectRequired(input.organizationId);
      sendErr = new SendError(
        "reconnect_required",
        "El token de WhatsApp expiró: reconecta el número en Configuración"
      );
    } else {
      sendErr = new SendError(
        "upload_failed",
        "No se pudo subir el adjunto a WhatsApp"
      );
    }
    // O conteúdo NÃO se perde: mensagem failed com o asset já no disco.
    sendErr.messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: null,
      type: kind,
      text: null,
      status: "failed",
      error: sendErr.message,
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    throw sendErr;
  }
}

export type LocationInput = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type ContactInput = { name: string; phone: string };

/** 008 — Envia uma localização ou contatos (payload estruturado, sem arquivo). */
export async function sendStructured(
  input: {
    conversationId: string;
    organizationId: string;
  } & (
    | { kind: "location"; location: LocationInput }
    | { kind: "contacts"; contacts: ContactInput[] }
  )
): Promise<SendResult> {
  const target = await prepareSend(
    input.conversationId,
    input.organizationId
  );
  // Localizações e contatos são mensagens do WhatsApp: nos demais canais não
  // há credenciais do WhatsApp para usar e o Graph os rejeitaria.
  if (!target.credentials) {
    throw new SendError(
      "meta_error",
      "Este canal no admite ubicaciones ni contactos; manda el texto"
    );
  }

  const payload =
    input.kind === "location"
      ? { type: "location", location: input.location }
      : {
          type: "contacts",
          contacts: input.contacts.map((c) => ({
            name: { formatted_name: c.name, first_name: c.name },
            phones: [{ phone: c.phone, type: "CELL" }],
          })),
        };

  const waMessageId = await callGraphSend(target.credentials, {
    messaging_product: "whatsapp",
    ...target.destinatario,
    ...payload,
  });

  const db = getDb();
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: newId("mediaAsset"),
      organizationId: input.organizationId,
      kind: input.kind,
      payload: input.kind === "location" ? input.location : input.contacts,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  const messageId = await persistOutbound({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    waMessageId,
    type: input.kind,
    text: null,
    status: "pending",
    origin: "operator",
    mediaAssetId: asset.id,
    media: asset,
  });
  return { messageId };
}

/** Chama o Graph /messages e traduz os erros da Meta para SendError. */
export async function callGraphSend(
  credentials: Credentials,
  payload: unknown
): Promise<string> {
  try {
    const res = await graphRequest<{ messages?: { id: string }[] }>(
      `${credentials.phoneNumberId}/messages`,
      { method: "POST", token: credentials.token, body: payload }
    );
    const id = res.messages?.[0]?.id;
    if (!id) throw new SendError("meta_error", "Meta no devolvió ID de mensaje");
    return id;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(credentials.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de WhatsApp expiró: reconecta el número en Configuración"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError("meta_unavailable", "Meta no está disponible ahora");
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}


/**
 * 014 — Envio pelo canal do Instagram. Traduz as falhas para o mesmo
 * vocabulário de SendError que já usa o WhatsApp, para que a caixa de entrada não
 * tenha que aprender um idioma por plataforma.
 */
async function callInstagramSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.instagram!;

  const caps = capabilitiesFor("instagram");
  if (!textFits("instagram", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // O Instagram não tem templates: fora da janela de 24 h a única via
  // é a etiqueta de agente humano (até 7 dias). 024: quem pode usá-la
  // já foi decidido pelo pré-voo.
  const humanAgentTag = target.humanAgentTag ?? false;

  try {
    const res = await sendInstagramText({
      credentials: creds,
      recipient: target.recipient,
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markInstagramReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de Instagram expiró o fue revocado: reconecta la cuenta"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          "Instagram no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}

/**
 * 017 — Envio pelo canal do Messenger. Mesmo vocabulário de SendError que
 * o WhatsApp e o Instagram: a caixa de entrada não aprende um idioma por plataforma.
 */
async function callMessengerSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.messenger!;

  const caps = capabilitiesFor("messenger");
  if (!textFits("messenger", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // O Messenger não tem templates: fora da janela de 24 h a única via
  // é a etiqueta de agente humano (até 7 dias). 024: quem pode usá-la
  // já foi decidido pelo pré-voo.
  const humanAgentTag = target.humanAgentTag ?? false;

  try {
    const res = await sendMessengerText({
      credentials: creds,
      recipient: target.recipient,
      // A Zernio responde dentro DA SUA conversa, não ao PSID: sem esta
      // referência o envio não tem para onde ir.
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markMessengerReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de la página expiró o fue revocado: reconecta Messenger"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          "Messenger no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}

/**
 * 022 — Envio pelo canal do TikTok. Mesmo vocabulário de SendError dos
 * demais canais. A janela e o teto já foram verificados em `prepareSend`.
 */
async function callTiktokSend(target: SendTarget, text: string): Promise<string> {
  const creds = target.tiktok!;

  try {
    const res = await sendTiktokText({
      credentials: creds,
      // A Zernio responde dentro DA SUA conversa: sem esta referência o
      // envio não tem para onde ir.
      threadRef: target.conversation.channelThreadRef,
      text,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markTiktokReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "La llave de Zernio expiró o fue revocada: reconecta TikTok"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          "TikTok no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}
