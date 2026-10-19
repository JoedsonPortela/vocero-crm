/**
 * 015 — O catálogo de conectores de agenda, sem dependências de servidor.
 *
 * Vive em `lib/` pelo mesmo motivo que `lib/channels.ts`: a interface também
 * precisa saber quais conectores existem, como se chamam e o que prometem, para
 * que Ajustes → Agenda possa oferecê-los sem duplicar a lista à mão.
 *
 * Um conector é a forma como o agendamento vira uma reunião. O motor
 * não conhece provedores: PERGUNTA capacidades, igual ao envio que pergunta as
 * do canal. Adicionar o seu em um fork é escrever o seu adaptador e declará-lo
 * aqui — ver docs/agenda-conectores.md.
 */

export type ConnectorId = "enlace-fijo" | "zoom" | "google";

/** Ordem em que são apresentados ao operador. O soberano primeiro. */
export const CONNECTOR_ORDER: readonly ConnectorId[] = [
  "enlace-fijo",
  "zoom",
  "google",
];

export type ConnectorMeta = {
  label: string;
  /** O que faz, em uma linha, para a tela de Ajustes. */
  description: string;
  /** Gera um link diferente por agendamento? (`enlace-fijo` não: é a sala de sempre.) */
  perBookingLink: boolean;
  /** Reagendar move a reunião no provedor? */
  updatesMeeting: boolean;
  /** O agendamento aparece também no calendário do dono? */
  writesCalendarEvent: boolean;
  /**
   * Fala com um serviço de terceiros? É a porta constitucional: os
   * conectores externos existem apenas desligados por padrão, isolados atrás do
   * seu adaptador e degradando sem bloquear (Princípio II, 1.4.0).
   */
  external: boolean;
};

export const CONNECTOR_META: Record<ConnectorId, ConnectorMeta> = {
  "enlace-fijo": {
    label: "Link fixo",
    description:
      "Sua sala de sempre: cole a URL uma vez e cada consulta a usa. Sem conectar nada.",
    perBookingLink: false,
    updatesMeeting: false,
    writesCalendarEvent: false,
    external: false,
  },
  zoom: {
    label: "Zoom",
    description:
      "Cada consulta cria sua reunião no Zoom. Reagendar a move; cancelar a exclui.",
    perBookingLink: true,
    updatesMeeting: true,
    // O Zoom sincroniza com o calendário do dono por conta própria, se ele o
    // configurou lá; o CRM não faz isso nem sabe.
    writesCalendarEvent: false,
    external: true,
  },
  google: {
    label: "Google Calendar + Meet",
    description:
      "Cada consulta cria um evento no seu calendário com o link do Meet.",
    perBookingLink: true,
    updatesMeeting: true,
    writesCalendarEvent: true,
    external: true,
  },
};

export function isConnectorId(value: string): value is ConnectorId {
  return (CONNECTOR_ORDER as readonly string[]).includes(value);
}

/** O conector padrão: o único que não depende de ninguém. */
export const DEFAULT_CONNECTOR: ConnectorId = "enlace-fijo";
