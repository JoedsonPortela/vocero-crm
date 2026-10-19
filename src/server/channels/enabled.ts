import { getEnv } from "@/lib/env";
import { isChannel, type Channel } from "@/lib/channels";

/**
 * 014 — Quais canais estão ligados nesta instância.
 *
 * O código de todos os canais viaja sempre na main; o que decide se eles
 * existem para o usuário é a variável `CHANNELS`. Uma instalação normal
 * (`CHANNELS=whatsapp`, o padrão) não vê o Instagram por nenhum lado: nem
 * tela, nem webhook, nem variáveis para preencher.
 *
 * Foi feito assim, e não com um ramo por funcionalidade, porque um ramo precisa
 * se manter compatível com a main E com as demais ramificações opcionais, e sua
 * cadeia de migrações diverge sem conserto possível. Com a bandeira há UMA
 * cadeia de migrações para todo mundo, e os conflitos são resolvidos pelo
 * autor uma vez, não por cada usuário em cada atualização.
 *
 * A migração é aplicada sempre: uma coluna com padrão e uma tabela vazia
 * são inertes, e em troca todas as instâncias têm a mesma estrutura.
 */

/** O WhatsApp não pode ser desligado: é o canal pelo qual o produto existe. */
const ALWAYS_ON: Channel = "whatsapp";

export function parseChannels(raw: string | undefined): Set<Channel> {
  const enabled = new Set<Channel>([ALWAYS_ON]);
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    // Qualquer canal do catálogo, não uma lista escrita à mão aqui: o
    // canal seguinte só precisa existir em lib/channels.ts.
    if (isChannel(name)) enabled.add(name);
  }
  return enabled;
}

export function enabledChannels(): Set<Channel> {
  return parseChannels(getEnv().CHANNELS);
}

export function isChannelEnabled(channel: Channel): boolean {
  return enabledChannels().has(channel);
}

/**
 * Resposta para uma superfície de um canal desligado. 404 e não 403 de
 * propósito: se o canal não estiver ligado, esse endpoint não existe nesta
 * instância — não há nada a revelar sobre ele.
 */
export function channelDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
