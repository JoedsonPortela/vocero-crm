import { createHmac } from "node:crypto";
import { getEnv } from "@/lib/env";
import { nextN } from "@/server/dev/wa-mock-state";

/**
 * Constrói um payload real da Meta e o entrega ao webhook público por
 * loopback (127.0.0.1: mesmo processo, sem sair para a rede). Assina-se com o
 * META_APP_SECRET real se estiver configurado — assim o self-test exercita a
 * camada 2 de verdade.
 */
export async function deliverToWebhook(payload: unknown): Promise<Response> {
  const env = getEnv();
  const raw = JSON.stringify(payload);
  const port = process.env.PORT ?? "3000";
  const url = `http://127.0.0.1:${port}/api/webhooks/wa/${env.META_WEBHOOK_VERIFY_TOKEN}`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (env.META_APP_SECRET) {
    const sig = createHmac("sha256", env.META_APP_SECRET)
      .update(raw, "utf8")
      .digest("hex");
    headers["x-hub-signature-256"] = `sha256=${sig}`;
  }
  return fetch(url, { method: "POST", headers, body: raw });
}

/** 008 — Campos de anexo que aceitam os payloads simulados. */
type MockMediaInput = {
  /** id de mídia do Graph simulado (servível por wa-mock/media-file). */
  mediaId?: string;
  mimeType?: string;
  caption?: string;
  filename?: string;
  location?: Record<string, unknown>;
};

/**
 * #78 — Respostas de botão com a forma da Meta. `button` é a resposta a
 * um botão de template; `interactive` se passa inteiro (como o `referral`)
 * para poder testar `button_reply`, `list_reply` e as formas quebradas.
 */
type MockButtonInput = {
  button?: { text: string; payload?: string };
  interactive?: Record<string, unknown>;
};

const MOCK_BINARY_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

function applyMockContent(
  message: Record<string, unknown>,
  type: string,
  input: { text?: string } & MockMediaInput & MockButtonInput
): void {
  if (type === "text") {
    message.text = { body: input.text ?? "hola" };
  } else if (type === "button") {
    // Como o envia a Meta: `context` aponta para o template que trazia o botão.
    const text = input.button?.text ?? input.text ?? "Sí";
    message.context = { from: "5215500000000", id: `wamid.mock.tpl.${nextN()}` };
    message.button = { payload: input.button?.payload ?? text, text };
  } else if (type === "interactive") {
    message.context = { from: "5215500000000", id: `wamid.mock.int.${nextN()}` };
    message.interactive = input.interactive ?? {
      type: "button_reply",
      button_reply: { id: "btn_mock", title: input.text ?? "Sí" },
    };
  } else if (type === "location") {
    message.location = input.location ?? {
      latitude: 21.019,
      longitude: -101.257,
      name: "Oficina",
    };
  } else if (MOCK_BINARY_TYPES.has(type)) {
    const media: Record<string, unknown> = {
      id: input.mediaId ?? `mockmedia_${nextN()}`,
      mime_type:
        input.mimeType ?? (type === "audio" ? "audio/ogg" : "image/jpeg"),
    };
    if (input.caption) media.caption = input.caption;
    if (input.filename) media.filename = input.filename;
    message[type] = media;
  }
}

/** 016 — Campos para simular que a mensagem veio de um anúncio CTWA. */
type MockReferralInput = {
  /** Identificador do clique. Sem ele não há nada a reportar à Meta. */
  ctwaClid?: string;
  adHeadline?: string;
  adSourceId?: string;
  /**
   * 018 — O `referral` tal como o enviaria a Meta. Prevalece sobre os campos de
   * cima e se passa inteiro, não campo por campo, para poder testar também as
   * formas estranhas (sem `source_id`, cadeias gigantes, tipos errados) e a
   * URL do criativo.
   */
  referral?: Record<string, unknown>;
};

export function buildInboundPayload(input: {
  wabaId: string;
  phoneNumberId: string;
  /** Telefone do remetente. Omita e use `fromUserId` para simular BSUID (003). */
  from?: string;
  /** BSUID do remetente — pode vir sozinho ou junto com `from`. */
  fromUserId?: string;
  name?: string;
  type?: string;
  text?: string;
  waMessageId?: string;
  timestamp?: number;
} & MockMediaInput &
  MockReferralInput &
  MockButtonInput) {
  const type = input.type ?? "text";
  const message: Record<string, unknown> = {
    id: input.waMessageId ?? `wamid.mock.in.${nextN()}`,
    timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    type,
  };
  if (input.from) message.from = input.from;
  if (input.fromUserId) message.from_user_id = input.fromUserId;
  applyMockContent(message, type, input);

  // 016 — O referral só viaja quando a conversa nasceu de um anúncio, e
  // normalmente só na primeira mensagem. Monta-se igual ao real para que
  // a ingestão não saiba que fala com um mock.
  if (input.referral) {
    message.referral = input.referral;
  } else if (input.ctwaClid || input.adHeadline || input.adSourceId) {
    message.referral = {
      source_type: "ad",
      source_id: input.adSourceId ?? "1200000000000",
      source_url: "https://fb.me/anuncio-de-prueba",
      headline: input.adHeadline ?? "Anuncio de prueba",
      body: "Escríbenos por WhatsApp",
      media_type: "image",
      ...(input.ctwaClid ? { ctwa_clid: input.ctwaClid } : {}),
    };
  }

  const contactEntry: Record<string, unknown> = {
    /**
     * Sem nome pedido, o payload vai SEM `profile` — como o da Meta.
     *
     * Antes inventava-se «Cliente», e isso deixou de ser inofensivo quando o
     * nome do contato passou a ser mantido em dia com o perfil (#51): uma
     * segunda mensagem da mesma pessoa o renomeava para «Cliente», algo que a
     * Meta nunca manda. Um mock que inventa dados acaba testando a
     * própria ficção.
     */
    ...(input.name ? { profile: { name: input.name } } : {}),
  };
  if (input.from) contactEntry.wa_id = input.from;
  if (input.fromUserId) contactEntry.user_id = input.fromUserId;

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5215500000000",
                phone_number_id: input.phoneNumberId,
              },
              contacts: [contactEntry],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/**
 * 008 — Payload de echo de coexistence (`smb_message_echoes`): uma mensagem que
 * o dono enviou À MÃO pelo app do WhatsApp Business do telefone.
 */
export function buildEchoPayload(input: {
  wabaId: string;
  phoneNumberId: string;
  /** wa_id do LEAD destinatário. */
  to: string;
  /** Número do negócio (remetente do echo). */
  from?: string;
  type?: string;
  text?: string;
  waMessageId?: string;
  timestamp?: number;
  /** Variante defensiva: entrega sob a chave `messages` em vez de `message_echoes`. */
  useMessagesKey?: boolean;
} & MockMediaInput) {
  const type = input.type ?? "text";
  const message: Record<string, unknown> = {
    id: input.waMessageId ?? `wamid.mock.echo.${nextN()}`,
    timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    type,
    from: input.from ?? "5215500000000",
    to: input.to,
  };
  applyMockContent(message, type, input);

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId,
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5215500000000",
                phone_number_id: input.phoneNumberId,
              },
              ...(input.useMessagesKey
                ? { messages: [message] }
                : { message_echoes: [message] }),
            },
          },
        ],
      },
    ],
  };
}

export function buildStatusPayload(input: {
  wabaId: string;
  phoneNumberId: string;
  waMessageId: string;
  status: string;
  recipientId?: string;
  /** A Meta anexa `errors[]` nos `failed` (ex.: 130472 de 2026-08-05). */
  errorCode?: number;
  errorMessage?: string;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5215500000000",
                phone_number_id: input.phoneNumberId,
              },
              statuses: [
                {
                  id: input.waMessageId,
                  status: input.status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: input.recipientId ?? "5215511111111",
                  ...(input.errorCode != null
                    ? {
                        errors: [
                          {
                            code: input.errorCode,
                            title: input.errorMessage ?? "Error de envío",
                            message: input.errorMessage ?? "Error de envío",
                          },
                        ],
                      }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function buildTemplateStatusPayload(input: {
  wabaId: string;
  name: string;
  language: string;
  event: "APPROVED" | "REJECTED";
  reason?: string;
  templateId?: string;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId,
        changes: [
          {
            field: "message_template_status_update",
            value: {
              event: input.event,
              message_template_id: input.templateId ?? `tplmock_${nextN()}`,
              message_template_name: input.name,
              message_template_language: input.language,
              reason: input.reason ?? null,
            },
          },
        ],
      },
    ],
  };
}
