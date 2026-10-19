/**
 * 014 — O canal, em um só lugar e sem dependências de servidor.
 *
 * Vive em `lib/` e não em `server/` porque a interface também precisa saber
 * quais canais existem e como se chamam. Antes o tipo estava declarado duas
 * vezes (em `server/inbox/identity.ts` e outra vez à mão dentro do DTO de
 * `lib/types.ts`): adicionar um canal obrigava a lembrar dos dois lugares, e
 * esquecer um deles não quebrava a compilação — só deixava uma tela
 * mentindo.
 */

export type Channel = "whatsapp" | "instagram" | "messenger" | "tiktok";

/**
 * Ordem em que os canais são apresentados ao operador. WhatsApp primeiro: é o
 * canal que toda instância tem ligado.
 */
export const CHANNEL_ORDER: readonly Channel[] = [
  "whatsapp",
  "instagram",
  "messenger",
  "tiktok",
];

/** Nome visível do canal, para a interface e para os erros do operador. */
export const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  // 017: as mensagens da página do Facebook. "Messenger" e não "Facebook"
  // porque é o que o cliente vê no seu telefone quando escreve.
  messenger: "Messenger",
  // 022: as mensagens diretas de uma conta TikTok Business, pelo Zernio.
  tiktok: "TikTok",
};

/**
 * 028 — O rótulo sob o logo. Com um só canal, o de sempre; com mais,
 * dizer «WhatsApp» contaria ao operador só metade do que o seu CRM faz.
 */
export function navKicker(channels: readonly Channel[]): string {
  return channels.length > 1 ? "CRM · Multicanal" : "CRM · WhatsApp";
}

/** 028 — O mesmo para o título da aba e a tela de entrada. */
export function productName(channels: readonly Channel[]): string {
  return channels.length > 1 ? "CRM multicanal" : "CRM de WhatsApp";
}

export function isChannel(value: string): value is Channel {
  return (CHANNEL_ORDER as readonly string[]).includes(value);
}
