"use client";

import { t } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, MessageSquareText, Sparkles, Video, X } from "lucide-react";
import { addDaysISO } from "@/lib/time/slots";
import {
  bookingSegments,
  dayHeading,
  groupSlotsByDay,
  hhmm,
  longDayLabel,
  type DaySlot,
} from "@/lib/time/calendar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bookingTitle, bookingTone, canRetrySync, statusLabel, type Booking } from "./booking-look";

/**
 * 215 — O agendamento, aberto, sem sair do calendário. Tem TUDO o que tinha o
 * cartão da lista antes (ações, link, notas e a nova tentativa do
 * link): o calendário muda como a agenda se vê, não o que se pode fazer
 * com ela.
 */

export type ActResult = { ok: true } | { ok: false; message: string };

export function BookingDrawer({
  booking: b,
  timezone,
  today,
  nowMs,
  onClose,
  onAct,
  onRescheduled,
}: {
  booking: Booking;
  timezone: string;
  today: string;
  nowMs: number;
  onClose: () => void;
  /** PATCH no agendamento; devolve o erro do servidor, se houver. */
  onAct: (body: Record<string, unknown>) => Promise<ActResult>;
  /** O agendamento foi movido: o calendário pula para o novo dia. */
  onRescheduled: (startUtc: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);

  // Outro agendamento, outro painel: nem o erro nem o seletor de horários são herdados.
  useEffect(() => {
    setError(null);
    setRescheduling(false);
  }, [b.id]);

  // Escape fecha: o mesmo gesto da gaveta do Pipeline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    const result = await onAct(body);
    setBusy(false);
    if (!result.ok) setError(result.message);
    return result.ok;
  }

  const segments = bookingSegments(b.scheduledAtUtc, b.durationMinutes, timezone);
  const first = segments[0];
  const last = segments[segments.length - 1];
  const isSession = b.kind === "session";
  const active = b.status === "agendada";
  const endMs = Date.parse(b.scheduledAtUtc) + b.durationMinutes * 60_000;
  const tone = bookingTone(b);

  return (
    <>
      {/* Véu só no celular, onde o painel cobre tudo. No desktop o
          painel é lateral e NÃO modal, como o detalhe do Google: tocar em outro
          agendamento do calendário troca o painel sem fechá-lo antes. */}
      <button
        aria-label={t("bookings.closeBooking")}
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-overlay md:hidden"
      />

      <aside
        role="dialog"
        aria-label={`${isSession ? "Cita" : "Bloqueo"}: ${bookingTitle(b)}`}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(400px,94vw)] flex-col border-l bg-popover shadow-pop lg:static lg:z-auto lg:w-[360px] lg:shrink-0 lg:shadow-none"
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="kicker text-text-2">{isSession ? "Cita" : "Bloqueo de horario"}</h3>
          <button
            autoFocus
            onClick={onClose}
            aria-label={t("bookings.closeBookingPanel")}
            className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {/* O quê e quando */}
          <section className="space-y-3 border-b p-4">
            <div className="flex items-start gap-3">
              <span aria-hidden className={cn("mt-1.5 h-3 w-3 shrink-0 rounded-full", tone.dot)} />
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-[17px] font-bold leading-snug",
                    b.status === "cancelada" && "text-text-3 line-through"
                  )}
                >
                  {bookingTitle(b)}
                </p>
                {first && last && (
                  <p className="mt-0.5 text-sm text-text-2 first-letter:uppercase">
                    {longDayLabel(first.day)} · {hhmm(first.startMin)} – {hhmm(last.endMin)}
                    {last.day !== first.day && t("bookings.nextDay")}
                  </p>
                )}
                <p className="text-xs text-text-3">
                  {b.durationMinutes} min · {timezone}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant={
                  b.status === "realizada"
                    ? "success"
                    : b.status === "no_show"
                      ? "warning"
                      : b.status === "cancelada"
                        ? "secondary"
                        : "default"
                }
              >
                {statusLabel(b)}
              </Badge>
              {isSession && (
                <Badge variant="secondary" className="gap-1">
                  {b.source === "ai" && <Sparkles className="h-3 w-3" />}
                  {b.source === "ai" ? t("bookings.byAi") : t("bookings.manual")}
                </Badge>
              )}
              {b.isTest && <Badge variant="secondary">Prueba del Laboratorio</Badge>}
              {canRetrySync(b) && <Badge variant="warning">Sin enlace</Badge>}
            </div>

            {active && endMs < nowMs && isSession && (
              <p className="rounded-sm bg-warning-tint px-3 py-2 text-xs text-warning-text">
                La hora ya pasó: márcala como realizada o como que no asistió.
              </p>
            )}
          </section>

          {/* Com quem e onde (a nota de um bloqueio já é o seu título) */}
          {((b.contact && b.conversationId) || b.meetingLink || (b.notes && isSession)) && (
            <section className="space-y-2 border-b p-4">
              {b.contact && b.conversationId && (
                <Link
                  href={`/inbox?contact=${b.contact.id}`}
                  className="flex w-full items-center justify-center gap-2 rounded-md border bg-secondary px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  <MessageSquareText className="h-4 w-4" /> Abrir conversación
                </Link>
              )}
              {b.meetingLink && (
                <a
                  href={b.meetingLink}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-2 break-all text-sm text-brand-text hover:underline"
                >
                  <Video className="h-4 w-4 shrink-0" /> Enlace de la reunión
                </a>
              )}
              {b.connector === "google" && (
                <p className="text-xs text-text-3">
                  Mueve y cancela desde Vocero: los cambios hechos en Google Calendar no se importan.
                </p>
              )}
              {b.notes && isSession && (
                <div>
                  <p className="kicker mb-1">Notas</p>
                  <p className="whitespace-pre-wrap text-sm text-text-2">{b.notes}</p>
                </div>
              )}
            </section>
          )}

          {/* O provedor falhou ao criar a reunião. O agendamento existe; a única
              coisa que falta é o link, e a nova tentativa é feita daqui — sem isso, uma
              falha pontual do provedor seria uma perda silenciosa. */}
          {canRetrySync(b) && (
            <section className="border-b p-4">
              <div className="space-y-2 rounded-sm bg-subtle p-3">
                <p className="text-sm text-text-2">
                  Esta cita quedó sin enlace: el proveedor no respondió.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run({ action: "retry_link" })}
                >
                  Reintentar enlace
                </Button>
              </div>
            </section>
          )}

          {rescheduling && (
            <Reschedule
              today={today}
              busy={busy}
              onCancel={() => setRescheduling(false)}
              onPick={async (startUtc) => {
                if (await run({ action: "reschedule", startUtc })) {
                  setRescheduling(false);
                  onRescheduled(startUtc);
                }
              }}
            />
          )}

          {error && (
            <p role="alert" className="mx-4 mt-4 rounded-sm bg-danger-tint px-3 py-2 text-sm text-danger-text">
              {error}
            </p>
          )}
        </div>

        {active && (
          <footer className="flex flex-wrap gap-2 border-t p-4">
            <Button
              size="sm"
              variant={rescheduling ? "default" : "secondary"}
              disabled={busy}
              onClick={() => setRescheduling((r) => !r)}
            >
              <CalendarClock className="h-3.5 w-3.5" /> Reprogramar
            </Button>
            {/* Um bloqueio não é "realizado" nem tem alguém que falte: só é movido
                ou removido. */}
            {isSession && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run({ action: "status", status: "realizada" })}
                >
                  Realizada
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run({ action: "status", status: "no_show" })}
                >
                  No asistió
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className="text-danger-text"
              onClick={() => void run({ action: "cancel" })}
            >
              {isSession ? "Cancelar cita" : "Quitar bloqueo"}
            </Button>
          </footer>
        )}
      </aside>
    </>
  );
}

/**
 * Os horários livres de TODA a janela do negócio, por dia. Antes eram os 12
 * primeiros —com agendamentos de 30 min, «hoje à tarde ou amanhã cedo»—.
 * São pedidos ao abrir, não a cada atualização: antes cada evento SSE (cada agendamento que
 * a IA marcava) recalculava a disponibilidade da janela inteira mesmo
 * que ninguém estivesse reagendando.
 */
function Reschedule({
  today,
  busy,
  onCancel,
  onPick,
}: {
  today: string;
  busy: boolean;
  onCancel: () => void;
  onPick: (startUtc: string) => void;
}) {
  const [slots, setSlots] = useState<DaySlot[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    // Fechar o painel (ou trocar de agendamento) cancela a consulta em andamento.
    const abort = new AbortController();
    let alive = true;
    void (async () => {
      const res = await fetch("/api/calendar/availability", { signal: abort.signal }).catch(
        () => null
      );
      if (!alive) return;
      if (!res?.ok) {
        setFailed(true);
        setSlots([]);
        return;
      }
      const data = (await res.json().catch(() => null)) as { slots: DaySlot[] } | null;
      if (alive) setSlots(data?.slots ?? []);
    })();
    return () => {
      alive = false;
      abort.abort();
    };
  }, []);

  const days = useMemo(() => groupSlotsByDay(slots ?? []), [slots]);
  const selected = day ?? days[0]?.[0] ?? null;
  const times = days.find(([d]) => d === selected)?.[1] ?? [];

  return (
    <section className="space-y-3 border-b p-4" aria-label="Mover a">
      <div className="flex items-center justify-between">
        <p className="kicker">Mover a</p>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-text-3 hover:text-foreground"
        >
          Cancelar
        </button>
      </div>

      {slots === null && <p className="text-sm text-text-3">Buscando huecos libres…</p>}
      {slots !== null && days.length === 0 && (
        <p className="text-sm text-text-3">
          {failed
            ? "No se pudo comprobar la disponibilidad. Intenta de nuevo."
            : "No hay huecos libres para mover esta cita."}
        </p>
      )}

      {days.length > 0 && (
        <>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Días con huecos">
            {days.map(([d, list]) => {
              const h = dayHeading(d);
              const prefix = d === today ? t("bookings.today") : d === addDaysISO(today, 1) ? t("bookings.tomorrow") : h.weekday;
              return (
                <button
                  key={d}
                  type="button"
                  data-day={d}
                  onClick={() => setDay(d)}
                  aria-pressed={d === selected}
                  className={cn(
                    "flex shrink-0 flex-col items-center rounded-md border px-2.5 py-1.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
                    d === selected ? "border-brand bg-brand-tint text-brand-text" : "hover:bg-accent"
                  )}
                >
                  <span className="text-[11px] font-medium first-letter:uppercase">{prefix}</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {h.day} {h.month}
                  </span>
                  <span className="text-[10.5px] text-text-3">{list.length} libres</span>
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Horarios libres">
            {times.map((s) => (
              <button
                key={s.startUtc}
                type="button"
                data-start={s.startUtc}
                disabled={busy}
                onClick={() => onPick(s.startUtc)}
                className="rounded-md border px-1 py-1.5 font-mono text-[12.5px] transition-colors hover:border-brand hover:bg-brand-tint hover:text-brand-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:opacity-50"
              >
                {s.time}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
