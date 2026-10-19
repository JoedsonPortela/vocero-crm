import { CHANNEL_LABEL, type Channel } from "@/lib/channels";

/**
 * 014 — Capacidades declaradas por canal.
 *
 * O núcleo NÃO deve conhecer as regras do WhatsApp: deve perguntá-las. Antes,
 * a janela de 24 h e o "usa um template aprovado" viviam embutidos no
 * caminho genérico de envio, então cada canal novo tinha que lutar contra
 * suposições que não eram suas — o Instagram não tem templates, e a sua saída
 * fora da janela é uma etiqueta.
 *
 * Adicionar um canal deveria ser: escrever o seu adaptador e declarar aqui o que
 * pode e não pode fazer.
 */

export type OutsideWindowStrategy =
  /** Só pode ser reaberta com um template aprovado (WhatsApp). */
  | "template"
  /** Marca-se a mensagem como resposta de agente humano (Instagram). */
  | "human_agent_tag"
  /** Não há como: fora da janela não se envia. */
  | "none";

export type ChannelCapabilities = {
  /** Rótulo legível, para mensagens de erro dirigidas ao operador. */
  label: string;
  /** Janela de serviço em ms desde a última mensagem recebida; null = sem janela. */
  windowMs: number | null;
  /** O que se pode fazer quando a janela está fechada. */
  outsideWindow: OutsideWindowStrategy;
  /**
   * 024 — Até quando uma PESSOA pode responder com a etiqueta de agente
   * humano, em ms desde a última mensagem recebida. null = o canal não tem essa
   * extensão. A IA nunca a usa: a Meta a reserva para pessoas.
   */
  humanAgentWindowMs: number | null;
  /**
   * 024 — Qual formato de texto o canal renderiza. `plain`: nenhum, então ao
   * texto da IA se tiram as marcas antes de enviá-lo.
   */
  textFormat: "whatsapp" | "plain";
  /** Limite de texto em BYTES (não caracteres); null = sem limite prático. */
  maxTextBytes: number | null;
  /**
   * 022 — Limite de texto em CARACTERES, para a plataforma que conta assim
   * (TikTok). null = não se aplica. Um canal declara o que a sua plataforma meça.
   */
  maxTextChars: number | null;
  /**
   * 022 — Quantas mensagens a plataforma aceita desde a última mensagem recebida.
   * null = sem teto. Não é um limite de velocidade: não se recupera esperando,
   * só quando o cliente volta a escrever.
   */
  maxOutboundPerWindow: number | null;
  /** Podem-se enviar anexos por este canal hoje? */
  outboundMedia: boolean;
  /**
   * 028 — Admite localização e contatos? São mensagens do WhatsApp: nos
   * demais canais o compositor nem os oferece.
   */
  structuredMessages: boolean;
  /**
   * O status da mensagem avança por webhook (entregue/lido)? Se não, a
   * aceitação da plataforma é a confirmação e a mensagem nasce `sent`
   * — sem isto ela fica com o relógio para sempre.
   */
  deliveryReceipts: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const CHANNEL_CAPABILITIES: Record<Channel, ChannelCapabilities> = {
  whatsapp: {
    label: CHANNEL_LABEL.whatsapp,
    windowMs: DAY_MS,
    outsideWindow: "template",
    humanAgentWindowMs: null,
    textFormat: "whatsapp",
    maxTextBytes: null,
    // 022: o limite da Meta para um texto. Antes vivia como um teto global no
    // esquema da API, igual para todos os canais; agora que um canal
    // admite mais (TikTok, 6.000), cada um declara o seu.
    maxTextChars: 4096,
    maxOutboundPerWindow: null,
    outboundMedia: true,
    structuredMessages: true,
    deliveryReceipts: true,
  },
  instagram: {
    label: CHANNEL_LABEL.instagram,
    windowMs: DAY_MS,
    outsideWindow: "human_agent_tag",
    humanAgentWindowMs: 7 * DAY_MS,
    textFormat: "plain",
    // A Meta corta em 1000 bytes: com acentos e emojis a margem real é menor
    // do que aparenta ao contar caracteres.
    maxTextBytes: 1000,
    maxTextChars: null,
    maxOutboundPerWindow: null,
    outboundMedia: false,
    structuredMessages: false,
    deliveryReceipts: false,
  },
  // 017: o Messenger compartilha a plataforma de mensagens da Meta com o Instagram
  // (mesma janela de 24 h, mesma etiqueta HUMAN_AGENT fora dela, sem
  // templates), mas admite textos mais longos: 2000 caracteres. Declara-se
  // em bytes para não ser mais generoso que a plataforma com acentos e emojis.
  messenger: {
    label: CHANNEL_LABEL.messenger,
    windowMs: DAY_MS,
    outsideWindow: "human_agent_tag",
    humanAgentWindowMs: 7 * DAY_MS,
    textFormat: "plain",
    maxTextBytes: 2000,
    maxTextChars: null,
    maxOutboundPerWindow: null,
    outboundMedia: false,
    structuredMessages: false,
    deliveryReceipts: false,
  },
  /**
   * 022: o que o TikTok impõe às mensagens diretas de uma conta de
   * negócio. Depois da última mensagem do cliente aceita até 10 mensagens em 48
   * horas e não há template nem etiqueta que reabra: fora disso o envio
   * falha. O texto se mede em caracteres (6.000). Admite uma imagem, mas o
   * envio de anexos fica fora desta entrega (spec 022 · D9).
   */
  tiktok: {
    label: CHANNEL_LABEL.tiktok,
    windowMs: 2 * DAY_MS,
    outsideWindow: "none",
    humanAgentWindowMs: null,
    textFormat: "plain",
    maxTextBytes: null,
    maxTextChars: 6000,
    maxOutboundPerWindow: 10,
    outboundMedia: false,
    structuredMessages: false,
    deliveryReceipts: false,
  },
};

/**
 * 022 — A janela de serviço de um canal, em ms. Com `null` (um canal sem
 * janela) devolve-se Infinity: nunca fecha.
 */
export function windowMsFor(channel: Channel): number {
  return capabilitiesFor(channel).windowMs ?? Number.POSITIVE_INFINITY;
}

export function capabilitiesFor(channel: Channel): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[channel] ?? CHANNEL_CAPABILITIES.whatsapp;
}

/** Mensagem para o operador quando a janela está fechada, conforme o canal. */
export function windowClosedMessage(channel: Channel): string {
  const caps = capabilitiesFor(channel);
  switch (caps.outsideWindow) {
    case "template":
      return "La ventana de 24 horas está cerrada; usa una plantilla aprobada";
    case "human_agent_tag":
      // 024: dentro da extensão o envio sai etiquetado sozinho e não se
      // pede nada ao operador; esta mensagem é para quando ela também venceu.
      return `La ventana de atención de ${caps.label} está cerrada: solo se puede contestar hasta ${dias(caps.humanAgentWindowMs)} después del último mensaje del cliente. Hay que esperar a que vuelva a escribir`;
    case "none":
      return `La ventana de ${caps.label} está cerrada y este canal no permite reabrirla: hay que esperar a que el cliente vuelva a escribir`;
  }
}

/**
 * 024 — Mensagem quando quem tenta escrever é a IA e a janela normal já
 * fechou, embora uma pessoa ainda possa responder.
 */
export function aiWindowClosedMessage(channel: Channel): string {
  const caps = capabilitiesFor(channel);
  return `La ventana de respuestas automáticas de ${caps.label} está cerrada: pasadas ${horas(caps.windowMs)} del último mensaje del cliente solo puede contestar una persona`;
}

const horas = (ms: number | null) => `${Math.round((ms ?? 0) / (60 * 60 * 1000))} horas`;
const dias = (ms: number | null) => `${Math.round((ms ?? 0) / DAY_MS)} días`;

/**
 * O texto mais longo que a API do CRM aceita, seja qual for o canal: o
 * maior dos que declaram limite em caracteres. É só a primeira barreira
 * (um body absurdo não chega ao banco); o limite de cada canal quem verifica
 * é o envio, que é quem sabe para qual canal vai.
 */
export const MAX_TEXT_CHARS_ANY_CHANNEL = Math.max(
  ...Object.values(CHANNEL_CAPABILITIES).map((c) => c.maxTextChars ?? 0)
);

/** O que se diz a quem manda um texto mais longo do que isso. */
export const TEXT_TOO_LONG_ANY_CHANNEL = `A mensagem é muito longa: o máximo é ${MAX_TEXT_CHARS_ANY_CHANNEL.toLocaleString("es-MX")} caracteres`;

/** Este texto cabe no canal? Verifica o limite que a sua plataforma meça. */
export function textFits(channel: Channel, text: string): boolean {
  const caps = capabilitiesFor(channel);
  if (caps.maxTextBytes !== null && Buffer.byteLength(text, "utf8") > caps.maxTextBytes) {
    return false;
  }
  // Caracteres como uma pessoa os conta (pontos de código), não unidades
  // UTF-16: um emoji é um.
  if (caps.maxTextChars !== null && [...text].length > caps.maxTextChars) {
    return false;
  }
  return true;
}

/** O limite de texto do canal, dito para o operador. */
export function textLimitMessage(channel: Channel): string {
  const caps = capabilitiesFor(channel);
  const limite =
    caps.maxTextChars !== null
      ? `${caps.maxTextChars.toLocaleString("es-MX")} caracteres`
      : `${caps.maxTextBytes} bytes`;
  return `${caps.label} no acepta mensajes de más de ${limite}: acorta el texto`;
}

/** Mensagem para o operador quando o canal não aceita mais mensagens. */
export function outboundLimitMessage(channel: Channel): string {
  const caps = capabilitiesFor(channel);
  return `${caps.label} solo permite ${caps.maxOutboundPerWindow} mensajes después del último mensaje del cliente: hay que esperar a que vuelva a escribir`;
}
