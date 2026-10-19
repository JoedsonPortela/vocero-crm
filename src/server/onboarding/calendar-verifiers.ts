import { isConnectorId } from "@/lib/agenda-connectors";

/**
 * A agenda está pronta para o agente agendar pelo negócio?
 *
 * Decide-se com o que está PERSISTIDO: horários e conector guardados em Configurações →
 * Agenda e o estado da credencial do conector. Que a reunião de fato
 * seja entregue quem demonstra é o teste de conexão de cada conector, não isto.
 *
 * Pura (sem banco de dados) para poder testar a tabela de decisão sozinha.
 * Adaptação de `calendar-verifiers.ts` do Vocero Cloud, reduzida ao catálogo da
 * raiz: `enlace-fijo`, `zoom` e `google` (que aqui faz agenda e Meet
 * numa só credencial).
 */
export type CalendarConfiguration = {
  connector: string;
  /** `{"mon":[{"start":"09:00","end":"18:00"}]}`; `unknown` porque vem do jsonb. */
  weeklyHours: unknown;
};

export type CalendarReadiness = "ready" | "pending" | "unsupported";

/** Quais conectores têm credencial guardada e aceita. */
export type CalendarConnections = { google: boolean; zoom: boolean };

const HORA = /^\d{2}:\d{2}$/;

/** Há ao menos um dia com um intervalo bem formado e não vazio? */
export function hasWeeklyHours(weeklyHours: unknown): boolean {
  if (!weeklyHours || typeof weeklyHours !== "object") return false;
  return Object.values(weeklyHours as Record<string, unknown>).some(
    (day) =>
      Array.isArray(day) &&
      day.some((slot: unknown) => {
        if (!slot || typeof slot !== "object") return false;
        const { start, end } = slot as { start?: unknown; end?: unknown };
        return (
          typeof start === "string" &&
          typeof end === "string" &&
          HORA.test(start) &&
          HORA.test(end) &&
          start < end
        );
      })
  );
}

export function verifyCalendar(
  configuration: CalendarConfiguration | undefined,
  connections: CalendarConnections = { google: false, zoom: false }
): CalendarReadiness {
  // Sem linha, ninguém guardou nada ainda: a agenda começa com horários de
  // fábrica utilizáveis, mas o guia pede que o dono os confirme.
  if (!configuration) return "pending";
  if (!hasWeeklyHours(configuration.weeklyHours)) return "pending";
  // Um conector que já não existe no código (você vinha de um fork): o motor
  // o rebaixa para o soberano ao ler, mas aqui se diz, para que o arrumem.
  if (!isConnectorId(configuration.connector)) return "unsupported";
  if (configuration.connector === "google" && !connections.google) return "pending";
  if (configuration.connector === "zoom" && !connections.zoom) return "pending";
  return "ready";
}
