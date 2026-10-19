import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 021 — O contrato do despacho: o que o CRM envia a um cérebro externo
 * quando um cliente escreve. Ver
 * `specs/021-despacho-estandar/contracts/despacho.md`. Este módulo define a
 * FORMA do evento e a assinatura; não fala com ninguém nem toca o banco.
 *
 * A regra que o sustenta: o cérebro recebe um evento NORMALIZADO. Não sabe
 * se a mensagem veio da Meta ou da Zernio e não tem credenciais de canal, de modo
 * que adicionar um canal não toca os cérebros e adicionar um cérebro não toca
 * os canais.
 *
 * É a mesma forma do despacho do Vocero Cloud (seu
 * `src/server/brains/contract.ts`), para que um mesmo cérebro sirva às duas
 * edições. A única diferença está em `mediaId`, e se explica abaixo.
 */

export type CanalDelEvento = "whatsapp" | "instagram" | "messenger" | "tiktok";

export type MensajeDelEvento = {
  id: string;
  at: string;
  type: string;
  text: string | null;
  /**
   * O id que aceita `GET /api/bot/media/{mediaId}` (o do Graph), não o id
   * interno do anexo. Na cloud é o contrário, porque lá a volta é
   * `/api/brains/media`; aqui a volta é `/api/bot/*` e não muda.
   */
  mediaId: string | null;
  /** Só com anexo. */
  mimeType?: string | null;
  /** Só com anexo. */
  caption?: string | null;
};

export type EventoDespacho = {
  dispatchId: string;
  organization: { id: string; slug: string | null };
  conversation: {
    id: string;
    channel: CanalDelEvento;
    aiEnabled: boolean;
    windowOpen: boolean;
    windowExpiresAt: string | null;
  };
  contact: {
    id: string;
    displayName: string;
    identity: string;
  };
  messages: MensajeDelEvento[];
  firstMessageAt: string;
  lastMessageAt: string;
};

/** O que é preciso saber de uma mensagem para colocá-la no evento. */
export type MensajeParaEvento = {
  id: string;
  createdAt: Date;
  type: string;
  text: string | null;
  media: {
    waMediaId: string | null;
    mimeType: string | null;
    caption: string | null;
  } | null;
};

/**
 * Monta o evento. Pura, e é a ÚNICA que o monta: a ordem das chaves é
 * contrato —assina-se o JSON exatamente como sai daqui— e
 * `tests/unit/despacho-contrato.test.ts` fixa um corpo e sua assinatura byte a
 * byte. A prova gêmea vive no repositório do cérebro.
 */
export function armarEvento(datos: {
  dispatchId: string;
  organization: { id: string; slug: string | null };
  conversation: {
    id: string;
    channel: CanalDelEvento;
    aiEnabled: boolean;
    windowOpen: boolean;
    windowExpiresAt: Date | null;
  };
  contact: { id: string; displayName: string; identity: string };
  messages: MensajeParaEvento[];
  firstMessageAt: Date;
  lastMessageAt: Date;
}): EventoDespacho {
  return {
    dispatchId: datos.dispatchId,
    organization: {
      id: datos.organization.id,
      slug: datos.organization.slug,
    },
    conversation: {
      id: datos.conversation.id,
      channel: datos.conversation.channel,
      aiEnabled: datos.conversation.aiEnabled,
      windowOpen: datos.conversation.windowOpen,
      windowExpiresAt: datos.conversation.windowExpiresAt?.toISOString() ?? null,
    },
    contact: {
      id: datos.contact.id,
      displayName: datos.contact.displayName,
      identity: datos.contact.identity,
    },
    messages: datos.messages.map(mensajeDelEvento),
    firstMessageAt: datos.firstMessageAt.toISOString(),
    lastMessageAt: datos.lastMessageAt.toISOString(),
  };
}

function mensajeDelEvento(m: MensajeParaEvento): MensajeDelEvento {
  const base = {
    id: m.id,
    at: m.createdAt.toISOString(),
    type: m.type,
    text: m.text,
    mediaId: m.media?.waMediaId ?? null,
  };
  // Sem algo para baixar, `mimeType` e `caption` não dizem nada: uma
  // localização ou um cartão de contato não têm media id.
  if (!m.media?.waMediaId) return base;
  return { ...base, mimeType: m.media.mimeType, caption: m.media.caption };
}

/**
 * 026 — Quem administra o negócio apagou uma conversa: o cérebro tem
 * que esquecê-la.
 *
 * Vai para a MESMA URL e com a MESMA assinatura de um despacho. Distingue-se por
 * `type`, que um despacho não traz: quem não conhecer este evento vê um corpo
 * sem `messages` e o rejeita, o que é inofensivo — não é reintentado.
 *
 * Não leva o conteúdo do apagado, só com o que encontrá-lo. `identity` vai
 * porque um cérebro costuma indexar sua memória por pessoa, não pelo id de
 * conversa do CRM.
 */
export type EventoOlvido = {
  type: "conversation.deleted";
  eventId: string;
  organization: { id: string; slug: string | null };
  conversation: { id: string; channel: CanalDelEvento };
  contact: { id: string; identity: string };
  deletedAt: string;
};

export const TIPO_OLVIDO = "conversation.deleted" as const;

/**
 * A ordem das chaves é contrato: assina-se o JSON exatamente como sai daqui.
 * É o mesmo corpo que envia o Vocero Cloud, e a prova gêmea de `nea-agent`
 * (`tests/test_olvido.py`) o tem copiado byte a byte, igual a
 * `tests/unit/olvido-contrato.test.ts` aqui.
 */
export function construirEventoOlvido(datos: {
  eventId: string;
  organization: { id: string; slug: string | null };
  conversation: { id: string; channel: CanalDelEvento };
  contact: { id: string; identity: string };
  deletedAt: Date;
}): EventoOlvido {
  return {
    type: TIPO_OLVIDO,
    eventId: datos.eventId,
    organization: {
      id: datos.organization.id,
      slug: datos.organization.slug,
    },
    conversation: {
      id: datos.conversation.id,
      channel: datos.conversation.channel,
    },
    contact: { id: datos.contact.id, identity: datos.contact.identity },
    deletedAt: datos.deletedAt.toISOString(),
  };
}

export const CABECERA_FIRMA = "x-vocero-signature";
export const CABECERA_DISPATCH = "x-vocero-dispatch-id";
export const CABECERA_ORG = "x-vocero-organization";
/** Para os eventos que não são um turno: hoje, `conversation.deleted` (026). */
export const CABECERA_EVENTO = "x-vocero-event";

/**
 * Assinatura do corpo CRU, com prefixo `sha256=`.
 *
 * O prefixo é contrato: o webhook da Zernio NÃO o leva e o nosso SIM. A
 * assimetria é do provedor, não nossa.
 */
export function firmarCuerpo(cuerpoCrudo: string, secreto: string): string {
  const hex = createHmac("sha256", secreto)
    .update(cuerpoCrudo, "utf8")
    .digest("hex");
  return `sha256=${hex}`;
}

/**
 * Verificação em tempo constante. O CRM não verifica os seus próprios despachos:
 * existe para que o cérebro de teste do arnês e os testes comprovem a
 * assinatura com a mesma regra que um cérebro real deve usar.
 */
export function firmaValida(
  cuerpoCrudo: string,
  secreto: string,
  firmaRecibida: string | null
): boolean {
  if (!firmaRecibida) return false;
  const esperada = Buffer.from(firmarCuerpo(cuerpoCrudo, secreto));
  const recibida = Buffer.from(firmaRecibida);
  if (esperada.length !== recibida.length) return false;
  return timingSafeEqual(esperada, recibida);
}

/**
 * Como se classifica o que o cérebro respondeu.
 *
 * Um 4xx (exceto 429) NÃO é reintentado: se o outro lado considera inválido o
 * corpo, enviá-lo três vezes só atrasa a queda para um humano, que é o
 * único que vai atender essa conversa. Um 3xx cai aqui também: não se
 * seguem redirecionamentos.
 */
export type ResultadoEntrega =
  | { ok: true }
  | { ok: false; reintentable: boolean; detalle: string };

export function clasificarRespuesta(status: number): ResultadoEntrega {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 429 || status >= 500) {
    return {
      ok: false,
      reintentable: true,
      detalle: `el cerebro respondió ${status}`,
    };
  }
  return {
    ok: false,
    reintentable: false,
    detalle: `el cerebro respondió ${status} (no se reintenta)`,
  };
}
