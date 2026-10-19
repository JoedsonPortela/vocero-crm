import { EventEmitter } from "node:events";

/**
 * Barramento de eventos in-process por organização (contrato sse.md).
 * Publicar SEMPRE depois do commit do BD. Uma instância = um processo,
 * então um EventEmitter é suficiente (sem filas externas — Constituição II).
 */

export type SseEvent =
  | { type: "message.new"; data: { conversationId: string; message: unknown } }
  | {
      type: "message.status";
      data: {
        conversationId: string;
        messageId: string;
        status: string;
        /** Motivo da falha, presente somente quando status = "failed". */
        error?: string | null;
      };
    }
  | { type: "conversation.updated"; data: { conversation: unknown } }
  /** 026 — alguém da equipe apagou a conversa: ela sai da caixa de entrada. */
  | {
      type: "conversation.deleted";
      data: { conversationId: string; contactId: string; contactDeleted: boolean };
    }
  /** 015 — algo mudou na agenda: a tela de Agendamentos se atualiza sozinha. */
  | { type: "booking.updated"; data: { bookingId: string } }
  | {
      type: "lab.run";
      data: {
        runId: string;
        status: string;
        progress: { done: number; total: number };
        score?: number | null;
      };
    };

const globalForBus = globalThis as unknown as { __voceroBus?: EventEmitter };

function getBus(): EventEmitter {
  if (!globalForBus.__voceroBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    globalForBus.__voceroBus = bus;
  }
  return globalForBus.__voceroBus;
}

export function publish(organizationId: string, event: SseEvent): void {
  getBus().emit(`org:${organizationId}`, event);
}

export function subscribe(
  organizationId: string,
  listener: (event: SseEvent) => void
): () => void {
  const bus = getBus();
  const channel = `org:${organizationId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}
