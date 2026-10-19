"use client";

import { t } from "@/lib/i18n";
import type { BotBlockDto } from "@/lib/analytics";
import { BarChart } from "./bar-chart";
import { Rate, Section, Subhead } from "./section";
import { RateCard, StatCard } from "./stat-card";

/**
 * 019 — O trabalho do agente: se responde, com que rapidez, quando passa para um
 * humano e —com a agenda ligada— como saem os agendamentos. Tudo sobre as
 * conversas que começaram no período, sem as do Laboratório.
 */
export function BotSection({
  data,
  loading,
  error,
  agenda,
}: {
  data: BotBlockDto | null;
  loading: boolean;
  error: string | null;
  /** 015 — Sem a flag AGENDA não se fala de agendamentos em lugar nenhum. */
  agenda: boolean;
}) {
  return (
    <Section
      id="agente"
      title={t("results.agentTitle")}
      hint={
        agenda
          ? t("results.agentHintFull")
          : t("results.agentHint")
      }
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data?.empty}
      emptyText={t("results.noConversationsYet")}
    >
      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <StatCard label="Conversaciones nuevas" value={String(data.conversations)} />
            <RateCard
              label={t("results.agentReplied")}
              rate={data.aiReplyRate}
              unit="con mensaje del cliente"
            />
            <StatCard
              label="Primera respuesta"
              value={
                data.firstResponseSeconds === null
                  ? "—"
                  : formatSegundos(data.firstResponseSeconds)
              }
              hint={
                data.firstResponseSample === 0
                  ? t("results.agentNoReply")
                  : `mediana de ${data.firstResponseSample} conversaciones`
              }
            />
            <RateCard
              label="Pasaron a un humano"
              rate={data.handoffRate}
              unit="conversaciones"
            />
          </div>

          {agenda && data.sessions && (
            <div>
              <Subhead>Citas del periodo</Subhead>
              {data.sessions.booked === 0 ? (
                <p className="text-sm text-text-3">Ninguna cita cae en este periodo.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-5">
                  <StatCard
                    label="Citas"
                    value={String(data.sessions.booked)}
                    hint={pendientes(data.sessions)}
                  />
                  <StatCard label="Realizadas" value={String(data.sessions.done)} />
                  <StatCard label="No llegaron" value={String(data.sessions.noShow)} />
                  <StatCard label="Canceladas" value={String(data.sessions.cancelled)} />
                  <RateCard
                    label="Asistencia"
                    rate={data.sessions.showRate}
                    unit="con desenlace"
                  />
                </div>
              )}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <Subhead>Por qué pasó a un humano</Subhead>
              <BarChart
                items={data.handoffs}
                emptyText={t("results.noHandoff")}
              />
            </div>

            <div>
              <Subhead>Ficha del prospecto</Subhead>
              {data.fichaCoverage === null ? (
                // `null` NÃO é 0 %: significa que o agente desta instância não escreve
                // na ficha. Mostrar 0 % seria acusá-lo de não fazer algo que nunca lhe
                // foi pedido.
                <p className="text-sm text-text-3">
                  Nadie está llenando la ficha de los prospectos. La escribe un cerebro
                  externo (<code className="font-mono text-xs">PUT /api/bot/ficha</code>) o
                  tu equipo desde el panel de la conversación.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    <Rate rate={data.fichaCoverage} unit="contactos nuevos" />
                  </p>
                  <p className="mt-1 text-xs text-text-3">
                    De los contactos que llegaron en este periodo, a cuántos les sacó datos.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

/** Os agendamentos do período que ainda não têm desfecho (seguem agendados). */
function pendientes(s: NonNullable<BotBlockDto["sessions"]>): string | undefined {
  const n = s.booked - s.done - s.noShow - s.cancelled;
  if (n <= 0) return undefined;
  return n === 1 ? "1 sin desenlace todavía" : `${n} sin desenlace todavía`;
}

/** Segundos em algo que se lê de relance. */
export function formatSegundos(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round((s / 3600) * 10) / 10} h`;
}
