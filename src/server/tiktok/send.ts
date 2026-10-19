import type { TiktokCredentials } from "@/server/tiktok/credentials";
import { sendZernioMessage } from "@/server/zernio";

/**
 * 022 — Fronteira de saída do canal do TikTok (Constituição II: toda requisição
 * a uma plataforma passa por um único módulo).
 *
 * Um único transporte: a Zernio, que responde DENTRO da sua conversa com o
 * `conversationId` opaco que a ingestão guardou. O TikTok não deixa o negócio
 * iniciar, então uma conversa sem essa referência não tem para onde ir.
 *
 * A janela de 48 horas e o teto de mensagens são verificados antes, em
 * `prepareSend` (`src/server/inbox/send.ts`): aqui só se envia.
 */

export type TiktokSendResult = { platformMessageId: string };

export async function sendTiktokText(input: {
  credentials: TiktokCredentials;
  threadRef: string | null;
  text: string;
}): Promise<TiktokSendResult> {
  return sendZernioMessage({
    token: input.credentials.token,
    accountId: input.credentials.accountRef,
    conversationId: input.threadRef,
    text: input.text,
  });
}
