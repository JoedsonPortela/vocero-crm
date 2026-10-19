import type { BookingListItem } from "@/server/agenda/queries";

/** 215 — Como um agendamento aparece e como é nomeado, igual nas quatro visões. */

export type Booking = BookingListItem;

export const STATUS_LABEL: Record<Booking["status"], string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

/** Um bloqueio não é "agendado" nem "cancelado": está ativo ou foi removido. */
export function statusLabel(b: Booking): string {
  if (b.kind === "block") return b.status === "cancelada" ? "Quitado" : "Activo";
  return STATUS_LABEL[b.status];
}

/** O que se lê na grade: o contato ou, num bloqueio, a sua nota. */
export function bookingTitle(b: Booking): string {
  if (b.kind === "block") return b.notes?.trim() || "Bloqueo";
  return b.contact?.name.trim() || "Sin contacto";
}

/**
 * Cor por estado, só com tokens (regra 1 de `tailwind.config.ts`). O que
 * está por vir é preenchido com o acento, como um evento do Google; o que já passou
 * é apagado para a sua tinta de estado, para que a semana seja lida de relance.
 */
export function bookingTone(b: Booking): { box: string; dot: string } {
  if (b.status === "cancelada") {
    return {
      box: "border-dashed border-border-strong bg-subtle text-text-3 line-through",
      dot: "bg-text-4",
    };
  }
  if (b.kind === "block") {
    return { box: "booking-hatch border-border-strong text-text-2", dot: "bg-text-3" };
  }
  if (b.status === "realizada") {
    return { box: "border-success-soft bg-success-tint text-success-text", dot: "bg-success" };
  }
  if (b.status === "no_show") {
    return { box: "border-warning-soft bg-warning-tint text-warning-text", dot: "bg-warning" };
  }
  return { box: "border-transparent bg-brand text-brand-fg", dot: "bg-brand" };
}

/**
 * O provedor falhou ao criar a reunião: o agendamento existe e a única coisa que falta
 * é o link, que é reenviado pelo painel. Nesta edição a entrega
 * é isso —o link do conector—; não há mais estados a vigiar.
 */
export function canRetrySync(b: Booking): boolean {
  return b.linkPending && b.status !== "cancelada";
}

/** Aviso pequeno na grade: o agendamento ficou sem link da reunião. */
export function hasDeliveryIssue(b: Booking): boolean {
  return canRetrySync(b);
}
