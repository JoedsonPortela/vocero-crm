/**
 * 015 — El catálogo de conectores de agenda, sem dependências de servidor.
 *
 * Vive en `lib/` por la misma razón que `lib/channels.ts`: la interfaz también
 * necesita saber qué conectores existen, cómo se llaman y qué prometen, para
 * que Ajustes → Agenda pueda ofrecerlos sin duplicar la lista a mano.
 *
 * Un conector es la forma en que la cita se convierte en una reunión. El motor
 * no sabe de proveedores: PREGUNTA capacidades, igual que el envío pregunta las
 * del canal. Agregar el tuyo en un fork es escribir su adaptador y declararlo
 * aquí — ver docs/agenda-conectores.md.
 */

export type ConnectorId = "enlace-fijo" | "zoom" | "google";

/** Orden en que se le presentan al operador. El soberano primero. */
export const CONNECTOR_ORDER: readonly ConnectorId[] = [
  "enlace-fijo",
  "zoom",
  "google",
];

export type ConnectorMeta = {
  label: string;
  /** Qué hace, en una línea, para la pantalla de Ajustes. */
  description: string;
  /** ¿Genera un link distinto por cita? (`enlace-fijo` no: es la sala de siempre.) */
  perBookingLink: boolean;
  /** ¿Reprogramar mueve la reunión en el proveedor? */
  updatesMeeting: boolean;
  /** ¿La cita aparece además en el calendario del dueño? */
  writesCalendarEvent: boolean;
  /**
   * ¿Habla con un servicio de terceros? Es la puerta constitucional: los
   * conectores externos existen solo apagados por defecto, aislados tras su
   * adaptador y degradando sin bloquear (Principio II, 1.4.0).
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
    // Zoom sincroniza con el calendario del dueño por su cuenta, si él lo
    // configuró allá; el CRM no lo hace ni lo sabe.
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

/** El conector por defecto: el único que no depende de nadie. */
export const DEFAULT_CONNECTOR: ConnectorId = "enlace-fijo";
