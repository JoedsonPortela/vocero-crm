/** DTOs que trafegam pela API interna (lado cliente). */

import type { Channel } from "@/lib/channels";

export type ConversationDto = {
  id: string;
  /** 014: canal da conversa, para o distintivo da bandeja. */
  channel: Channel;
  contact: { id: string; name: string; phone: string | null };
  stageName: string | null;
  aiEnabled: boolean;
  handoffAt: string | null;
  handoffReason: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  windowOpen: boolean;
  windowRemainingMs: number;
  /**
   * 024 — A janela humana do canal (Instagram e Messenger:
   * até 7 dias com a etiqueta de agente humano). `null` em um canal que não
   * a tem. `open` = a janela normal já fechou, mas uma pessoa ainda
   * pode responder; `remainingMs` é o que lhe resta.
   */
  humanWindow: { open: boolean; remainingMs: number } | null;
  /**
   * 028 — O que o compositor pode oferecer neste canal: anexos, e
   * localização ou contato. O servidor rejeita o resto igualmente.
   */
  composer: { media: boolean; structured: boolean };
  preview: string | null;
  /** 018: o anúncio que abriu a conversa, para a marca da lista. */
  anuncio: {
    headline: string | null;
    sourceId: string | null;
    /** `post` se foi uma publicação e não um anúncio. */
    sourceType: string | null;
  } | null;
};

/** 018 — De qual anúncio veio um contato, como a bandeja o vê. */
export type AnuncioDto = {
  sourceId: string | null;
  sourceType: string | null;
  /** Somente https. */
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  /** Imagem do criativo, servida por `/api/media/{id}`. */
  imageAssetId: string | null;
  /** Se a Meta enviou identificador de clique. O valor não sai do servidor. */
  hasCtwaClid: boolean;
  capturedAt: string;
};

/** 008 — Anexo de uma mensagem, para pré-visualização na conversa. */
export type MessageMediaDto = {
  assetId: string;
  kind:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "location"
    | "contacts";
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  caption: string | null;
  fetchStatus: "available" | "pending" | "failed";
  /** location {latitude, longitude, name?, address?} / contacts (subconjunto). */
  payload: unknown;
};

export type MessageDto = {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  type: string;
  text: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  /** Motivo da falha em linguagem simples quando status = "failed". */
  error: string | null;
  aiGenerated: boolean;
  /** 008 — Origem da saída (nas entradas vem 'operator' e é ignorado). */
  origin: "ai" | "operator" | "manual" | "template";
  media: MessageMediaDto | null;
  createdAt: string;
};

export type TemplateDto = {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  status: "draft" | "pending" | "approved" | "rejected";
  rejectionReason: string | null;
};

export type StageDto = {
  id: string;
  name: string;
  position: number;
  kind: "open" | "won" | "lost";
};

/** Um dado da ficha. Escalar de propósito: ver `server/bot/ficha`. */
export type FichaValue = string | number | boolean;

/**
 * Ficha de qualificação do lead. Chaves livres: cada negócio qualifica
 * de forma diferente, então quem pergunta — o agente ou o dono — as define e o CRM
 * não as fixa.
 */
export type FichaDto = Record<string, FichaValue>;

export type ContactDto = {
  id: string;
  name: string;
  /** null em contatos que chegaram só com BSUID (003). */
  phone: string | null;
  notes: string | null;
  /** Etapa do funil do lead associado; null se o contato não tiver lead. */
  stageName: string | null;
  archivedAt: string | null;
  /** De onde saiu o prospect, capturada ou deduzida. */
  source?: SourceDto;
  /** Prioridade do lead associado; null se ninguém a definiu. */
  priority?: PriorityValue | null;
  /** O que se sabe do lead. `{}` enquanto ninguém tenha qualificado. */
  ficha?: FichaDto;
  /** 027 — O agente não responde a esta pessoa: quem atende é o dono. */
  aiPaused?: boolean;
};

/* ============================================================
 * Registro de etapas
 * ============================================================ */

/** Por que um negócio foi perdido. Lista curta de propósito: uma taxonomia longa
 *  acaba respondida com "outro" e deixa de informar. */
export type LossReason =
  | "precio"
  | "no_es_perfil"
  | "sin_presupuesto"
  | "eligio_otro"
  | "nunca_contesto"
  | "otro";

export const LOSS_REASON_LABEL: Record<LossReason, string> = {
  precio: "Le pareció caro",
  no_es_perfil: "No era el perfil",
  sin_presupuesto: "Sin presupuesto ahora",
  eligio_otro: "Se fue con otro",
  nunca_contesto: "Nunca contestó",
  otro: "Otro",
};

/** Quem provocou uma movimentação de etapa. */
export type StageChangeSource = "dueno" | "bot" | "sistema" | "migracion";

/* ============================================================
 * Origem do prospect
 * ============================================================ */

export type SourceValue =
  | "anuncio"
  | "organico"
  | "referido"
  | "conocido"
  | "otro";

export type SourceDto = {
  /** "desconocida" quando ninguém a capturou e não foi possível deduzir. */
  value: SourceValue | "desconocida";
  /** `deducida` = foi inferida pelo sistema; `capturada` = foi definida pelo dono. */
  source: "capturada" | "deducida";
};

/* ============================================================
 * Prioridade do lead
 * ============================================================ */

/** Definida pelo dono; NULL = ninguém a decidiu (não é "média"). */
export type PriorityValue = "alta" | "media" | "baja";
