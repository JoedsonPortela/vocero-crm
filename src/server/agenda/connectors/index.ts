import { type ConnectorId } from "@/lib/agenda-connectors";
import type { CalendarSettings } from "@/server/agenda/settings";
import {
  ConnectorError,
  type AgendaConnector,
  type MeetingRequest,
  type MeetingResult,
  type TestConnectionResult,
} from "@/server/agenda/connectors/types";
import { enlaceFijoConnector } from "@/server/agenda/connectors/enlace-fijo";
import { zoomConnector } from "@/server/agenda/connectors/zoom";
import {
  getZoomCredentials,
  markZoomError,
} from "@/server/agenda/connectors/zoom-credentials";
import { googleConnector } from "@/server/agenda/connectors/google";
import {
  getGoogleCredentials,
  markGoogleError,
} from "@/server/agenda/connectors/google-credentials";

/**
 * 015 — O catálogo de conectores e a ÚNICA porta pela qual o motor fala
 * com um provedor.
 *
 * O serviço de agendamentos não conhece credenciais nem provedores: pede "entrega
 * esta reunião" e aqui se resolve com quê e com quais chaves. Por isso adicionar um
 * conector num fork não toca nem uma linha do motor: escreve-se o seu adaptador,
 * a sua tabela de credenciais e um ramo deste `switch`.
 */

/** Um conector com as suas credenciais já resolvidas: o genérico fica apagado. */
export type BoundConnector = {
  id: ConnectorId;
  createMeeting(req: MeetingRequest): Promise<MeetingResult>;
  updateMeeting(
    externalId: string,
    req: Pick<MeetingRequest, "startUtc" | "durationMinutes" | "timezone">
  ): Promise<void>;
  deleteMeeting(externalId: string): Promise<void>;
  testConnection(): Promise<TestConnectionResult>;
  /** Só se o conector a implementar (links assíncronos). */
  refreshMeeting?: (externalId: string) => Promise<MeetingResult>;
};

function bind<C>(conn: AgendaConnector<C>, creds: C): BoundConnector {
  const refresh = conn.refreshMeeting;
  return {
    id: conn.id,
    createMeeting: (req) => conn.createMeeting(creds, req),
    updateMeeting: (externalId, req) =>
      conn.updateMeeting(creds, externalId, req),
    deleteMeeting: (externalId) => conn.deleteMeeting(creds, externalId),
    testConnection: () => conn.testConnection(creds),
    refreshMeeting: refresh
      ? (externalId) => refresh.call(conn, creds, externalId)
      : undefined,
  };
}

/**
 * Resolve o conector pedido com as credenciais desta organização.
 *
 * Lança `ConnectorError` se o conector não estiver disponível ou faltarem
 * credenciais. O motor traduz essa exceção para "agendamento criado com link
 * pendente", que é honesto — em vez de entregar em silêncio o link de
 * outro conector.
 */
export async function bindConnector(
  organizationId: string,
  connectorId: ConnectorId,
  settings: CalendarSettings
): Promise<BoundConnector> {
  switch (connectorId) {
    case "enlace-fijo":
      return bind(enlaceFijoConnector, { meetingLink: settings.meetingLink });

    case "zoom": {
      const creds = await getZoomCredentials(organizationId);
      if (!creds) {
        throw new ConnectorError(
          "zoom",
          "Zoom no está conectado: faltan las credenciales"
        );
      }
      return bind(zoomConnector, creds);
    }

    case "google": {
      const creds = await getGoogleCredentials(organizationId);
      if (!creds) {
        throw new ConnectorError(
          "google",
          "Google no está conectado: faltan las credenciales"
        );
      }
      return bind(googleConnector, creds);
    }
  }
}

/**
 * Marca a credencial do conector como quebrada após um erro de autenticação,
 * para que Configurações mostre o cartão de reconexão. `enlace-fijo` não tem
 * credenciais para marcar.
 *
 * É o que evita a falha silenciosa do fork, onde o estado `error` existe
 * como enum e ninguém o escreve: o dono descobre que sua conexão morreu
 * pelo cliente que não recebeu seu link.
 */
export async function markConnectorAuthError(
  organizationId: string,
  connectorId: ConnectorId
): Promise<void> {
  switch (connectorId) {
    case "enlace-fijo":
      return;
    case "zoom":
      await markZoomError(organizationId);
      return;
    case "google":
      await markGoogleError(organizationId);
      return;
  }
}
