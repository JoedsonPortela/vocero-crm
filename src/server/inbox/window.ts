/**
 * Janela de serviço: só se pode enviar texto livre dentro de certo
 * tempo após a última mensagem RECEBIDA. Uma conversa sem recebidas
 * (p. ex. iniciada por template) tem a janela fechada.
 *
 * 022 — A duração é do canal: 24 horas no WhatsApp, Instagram e Messenger,
 * 48 no TikTok. Sai de `windowMsFor(channel)`
 * (`src/server/channels/capabilities.ts`); o valor padrão daqui é o
 * do WhatsApp, para quem não tem uma conversa à mão.
 */

import type { Channel } from "@/lib/channels";
import { capabilitiesFor, windowMsFor } from "@/server/channels/capabilities";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** 024 — Quem pode escrever agora em uma conversa, e como sai. */
export type ReplyWindow = {
  /** Janela normal do canal aberta: escreve qualquer um, pessoa ou IA. */
  standardOpen: boolean;
  /** Uma pessoa pode escrever (janela normal ou extensão humana). */
  operatorOpen: boolean;
  /** A resposta da pessoa sai com a etiqueta de agente humano. */
  humanAgentTag: boolean;
  /** O que resta para uma pessoa responder, em ms. */
  operatorRemainingMs: number;
};

/**
 * 024 — A janela de resposta de um canal, vista de quem escreve.
 *
 * Conta desde a última mensagem do CLIENTE: o que o negócio envia não a
 * alonga. Sem recebidas, com uma data inválida ou com uma do futuro não há
 * janela: não se pode afirmar que o cliente escreveu há pouco.
 */
export function replyWindow(
  channel: Channel,
  lastInboundAt: Date | null,
  now: Date = new Date()
): ReplyWindow {
  const cerrada: ReplyWindow = {
    standardOpen: false,
    operatorOpen: false,
    humanAgentTag: false,
    operatorRemainingMs: 0,
  };
  const elapsed = lastInboundAt ? now.getTime() - lastInboundAt.getTime() : NaN;
  if (!Number.isFinite(elapsed) || elapsed < 0) return cerrada;

  const standardMs = windowMsFor(channel);
  const standardOpen = elapsed < standardMs;
  if (!Number.isFinite(standardMs)) {
    return {
      standardOpen: true,
      operatorOpen: true,
      humanAgentTag: false,
      operatorRemainingMs: Number.MAX_SAFE_INTEGER,
    };
  }
  // A extensão nunca é mais curta que a janela normal.
  const limit = Math.max(standardMs, capabilitiesFor(channel).humanAgentWindowMs ?? 0);
  const operatorOpen = elapsed < limit;
  return {
    standardOpen,
    operatorOpen,
    humanAgentTag: operatorOpen && !standardOpen,
    operatorRemainingMs: operatorOpen ? limit - elapsed : 0,
  };
}

export function isWindowOpen(
  lastInboundAt: Date | null,
  now: Date = new Date(),
  windowMs: number = WINDOW_MS
): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < windowMs;
}

/** Milissegundos restantes da janela (0 se estiver fechada). */
export function windowRemainingMs(
  lastInboundAt: Date | null,
  now: Date = new Date(),
  windowMs: number = WINDOW_MS
): number {
  if (!lastInboundAt) return 0;
  // Um canal sem janela nunca fecha: não há «restante» para contar.
  if (!Number.isFinite(windowMs)) return Number.MAX_SAFE_INTEGER;
  const remaining = windowMs - (now.getTime() - lastInboundAt.getTime());
  return Math.max(0, remaining);
}

/** Quando a janela fecha; null sem recebidas ou em um canal sem janela. */
export function windowExpiresAt(
  lastInboundAt: Date | null,
  windowMs: number = WINDOW_MS
): Date | null {
  if (!lastInboundAt || !Number.isFinite(windowMs)) return null;
  return new Date(lastInboundAt.getTime() + windowMs);
}
