import { graphRequest, MetaApiError } from "@/lib/meta/client";
import type { MessengerCredentials } from "@/server/messenger/credentials";
import { sendZernioMessage } from "@/server/zernio";

/**
 * 017 — Fronteira de saída do canal do Messenger (Constituição II: toda
 * requisição a uma plataforma passa por um único módulo).
 *
 * Dois transportes, mesma assinatura: a Zernio (API unificada) e a Meta direto. O da
 * Meta fala com `graph.facebook.com`, o MESMO host do WhatsApp, então
 * reutiliza o cliente do Graph que já existe (`graphRequest`): mesma versão
 * de API, mesmo `META_GRAPH_BASE_URL` (e portanto o mesmo mock nos testes) e
 * os mesmos erros tipados que o resto do CRM já interpreta.
 */

export type MessengerSendResult = { platformMessageId: string };

/**
 * Corpo do envio pela Meta. Separado para poder afirmá-lo num teste sem
 * rede: a etiqueta de agente humano é o único que distingue um envio dentro
 * da janela de um fora dela, e errá-la não dá erro de compilação — dá um
 * 400 da Meta em produção às 2 da manhã.
 */
export function buildMessengerSendBody(input: {
  recipient: string;
  text: string;
  humanAgentTag: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    recipient: { id: input.recipient },
    message: { text: input.text },
    // RESPONSE dentro da janela padrão de 24 h. Fora, o Messenger não
    // tem templates: a única via é a etiqueta HUMAN_AGENT (7 dias).
    messaging_type: input.humanAgentTag ? "MESSAGE_TAG" : "RESPONSE",
  };
  if (input.humanAgentTag) body.tag = "HUMAN_AGENT";
  return body;
}

/**
 * Envia texto pelo transporte correspondente.
 *
 * `recipient` é o PSID (sem o prefixo `fb:`); `threadRef` é o
 * conversationId opaco da Zernio, que só é necessário nesse transporte.
 */
export async function sendMessengerText(input: {
  credentials: MessengerCredentials;
  recipient: string;
  threadRef: string | null;
  text: string;
  humanAgentTag?: boolean;
  /** Id da mensagem no Vocero: chave natural de idempotência na Zernio. */
  idempotencyKey?: string;
}): Promise<MessengerSendResult> {
  if (input.credentials.source === "zernio") {
    return sendZernioMessage({
      token: input.credentials.token,
      accountId: input.credentials.accountRef,
      conversationId: input.threadRef,
      text: input.text,
      humanAgentTag: input.humanAgentTag,
      idempotencyKey: input.idempotencyKey,
    });
  }
  return sendViaMeta(input);
}

/**
 * A Meta responde `{ recipient_id, message_id }`; o mock do Graph do ambiente
 * de testes responde com o formato do WhatsApp (`messages[0].id`), e
 * aceitam-se os dois para que o mesmo código sirva em ambos.
 */
async function sendViaMeta(input: {
  credentials: MessengerCredentials;
  recipient: string;
  text: string;
  humanAgentTag?: boolean;
}): Promise<MessengerSendResult> {
  const { pageId } = input.credentials;
  if (!pageId) {
    throw new MetaApiError(
      "La conexión de Messenger no tiene ID de página para enviar",
      { status: 400 }
    );
  }
  const res = await graphRequest<{
    message_id?: string;
    messages?: { id: string }[];
  }>(`${pageId}/messages`, {
    method: "POST",
    token: input.credentials.token,
    body: buildMessengerSendBody({
      recipient: input.recipient,
      text: input.text,
      humanAgentTag: input.humanAgentTag ?? false,
    }),
  });
  const id = res.message_id ?? res.messages?.[0]?.id;
  if (!id) {
    throw new MetaApiError("A Meta não devolveu o ID da mensagem", { status: 502 });
  }
  return { platformMessageId: String(id) };
}

/**
 * Nome visível de quem escreve. O webhook do Messenger da Meta não traz
 * nome —só o PSID—, e um contato chamado "8371…" na caixa de entrada é
 * inútil para o operador. Consulta-se o perfil com o token da
 * página; se a Meta não der (permissão ausente, perfil restrito) devolve-se
 * null e a ingestão cai no nome de reserva: nunca se bloqueia uma mensagem por
 * um nome. No modo Zernio não é preciso — o evento já traz o nome.
 */
export async function fetchMessengerProfileName(
  credentials: MessengerCredentials,
  psid: string
): Promise<string | null> {
  if (credentials.source !== "meta") return null;
  try {
    const res = await graphRequest<{
      first_name?: string;
      last_name?: string;
      name?: string;
    }>(`${psid}?fields=first_name,last_name`, { token: credentials.token });
    const full = [res.first_name, res.last_name]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ")
      .trim();
    return full || res.name?.trim() || null;
  } catch {
    return null;
  }
}
