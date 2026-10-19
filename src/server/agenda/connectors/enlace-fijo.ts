import type { AgendaConnector, MeetingResult } from "@/server/agenda/connectors/types";

/**
 * 015 — O conector soberano: a sala de sempre.
 *
 * Não fala com ninguém. É o padrão e a razão de ligar a agenda não
 * exigir credenciais de terceiros — e, em termos constitucionais, o "caminho
 * sem dependência externa" que torna admissíveis os demais (Princípio II,
 * 1.4.0).
 */

export type EnlaceFijoCreds = { meetingLink: string | null };

export const enlaceFijoConnector: AgendaConnector<EnlaceFijoCreds> = {
  id: "enlace-fijo",
  requiresCredentials: false,

  async createMeeting(creds): Promise<MeetingResult> {
    // Sem sala configurada o agendamento é criado mesmo assim, sem link: ninguém deve
    // prometer ao cliente um link que não existe.
    return { externalId: null, joinUrl: creds.meetingLink };
  },

  // A sala fixa não se move nem se apaga: é a mesma todos os dias.
  async updateMeeting() {},
  async deleteMeeting() {},

  async testConnection() {
    return { ok: true, detail: "El enlace fijo no requiere conexión" };
  },
};
