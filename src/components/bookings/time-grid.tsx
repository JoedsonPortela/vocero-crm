"use client";

import { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import {
  bookingSegments,
  dayHeading,
  hhmm,
  layoutOverlaps,
  offHoursBands,
  workingBands,
  type DaySegment,
} from "@/lib/time/calendar";
import type { WeeklyHours } from "@/server/agenda/settings";
import { cn } from "@/lib/utils";
import { bookingTitle, bookingTone, hasDeliveryIssue, type Booking } from "./booking-look";

/**
 * 215 — A grade de horas das visões Dia e Semana, como o Google Calendar:
 * cada agendamento ocupa a altura da sua duração, o que se sobrepõe divide a
 * largura, o não útil é sombreado e uma linha marca a hora atual.
 *
 * Tudo no fuso horário do negócio: o dia e o minuto de cada agendamento são decididos por
 * `bookingSegments`, não pelo relógio do navegador.
 */

/** Altura de uma hora. Com 30 min = 24 px cabe uma linha de texto legível. */
const HOUR_PX = 48;
const DAY_PX = HOUR_PX * 24;
const MIN_EVENT_PX = 18;
/** Sem horário nem agendamentos, a grade abre nesta hora. */
const DEFAULT_SCROLL_MIN = 8 * 60;

type Placed = DaySegment & { booking: Booking; col: number; cols: number };

export function TimeGrid({
  days,
  bookings,
  timezone,
  weeklyHours,
  today,
  nowMinutes,
  tzLabel,
  selectedId,
  ready,
  onSelect,
  onEmptySlot,
  onOpenDay,
}: {
  days: string[];
  bookings: Booking[];
  timezone: string;
  weeklyHours: WeeklyHours;
  today: string;
  nowMinutes: number;
  /** "GMT-6": o canto indica em qual fuso a grade está desenhada. */
  tzLabel: string;
  selectedId: string | null;
  /** Os agendamentos DESTE intervalo já chegaram: só então se decide a rolagem. */
  ready: boolean;
  onSelect: (b: Booking) => void;
  onEmptySlot: (day: string, time: string) => void;
  onOpenDay: (day: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, Placed[]>();
    const segments = new Map<string, (DaySegment & { booking: Booking })[]>();
    for (const b of bookings) {
      for (const s of bookingSegments(b.scheduledAtUtc, b.durationMinutes, timezone)) {
        if (!days.includes(s.day)) continue;
        const list = segments.get(s.day) ?? [];
        list.push({ ...s, booking: b });
        segments.set(s.day, list);
      }
    }
    for (const [day, list] of segments) map.set(day, layoutOverlaps(list));
    return map;
  }, [bookings, days, timezone]);

  // Abre onde começa o dia de trabalho (ou antes, se houver um agendamento mais
  // cedo), uma única vez por intervalo: uma atualização por SSE não deve mover a
  // grade que alguém está lendo.
  const rangeKey = `${days[0]}|${days.length}`;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready || scrolledFor.current === rangeKey) return;
    scrolledFor.current = rangeKey;
    const starts = [
      ...days.flatMap((d) => workingBands(weeklyHours, d).map((b) => b.startMin)),
      ...[...byDay.values()].flat().map((p) => p.startMin),
    ];
    const target = starts.length > 0 ? Math.min(...starts) : DEFAULT_SCROLL_MIN;
    el.scrollTop = Math.max(0, ((target - 45) / 60) * HOUR_PX);
  }, [ready, rangeKey, days, weeklyHours, byDay]);

  const multi = days.length > 1;
  const columns = `3.5rem repeat(${days.length}, minmax(${multi ? "5.5rem" : "0"}, 1fr))`;

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto rounded-lg border bg-card"
      style={{ "--cal-hour": `${HOUR_PX}px` } as React.CSSProperties}
    >
      <div className="grid" style={{ gridTemplateColumns: columns, minWidth: multi ? "40rem" : undefined }}>
        {/* Cabeçalhos: fixados no topo enquanto a grade rola. Camadas:
            canto > dias > horas > colunas (cada coluna isola as suas). */}
        <div className="sticky left-0 top-0 z-40 flex items-end justify-end border-b border-r bg-card px-1.5 pb-1.5 font-mono text-[10px] text-text-3">
          {tzLabel}
        </div>
        {days.map((day) => {
          const h = dayHeading(day);
          const isToday = day === today;
          return (
            <button
              key={day}
              type="button"
              onClick={() => onOpenDay(day)}
              disabled={!multi}
              aria-label={`Ver el ${h.weekday} ${h.day} en la vista de día`}
              className="sticky top-0 z-30 flex flex-col items-center gap-0.5 border-b border-l bg-card py-2 transition-colors enabled:hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-soft"
            >
              <span className={cn("kicker", isToday && "text-brand-text")}>{h.weekday}</span>
              <span
                className={cn(
                  "flex h-8 min-w-8 items-center justify-center rounded-full px-1 text-[17px] font-semibold tabular-nums",
                  isToday ? "bg-brand text-brand-fg" : "text-foreground"
                )}
              >
                {h.day}
              </span>
            </button>
          );
        })}

        {/* Coluna de horas. */}
        <div className="sticky left-0 z-20 border-r bg-card" style={{ height: DAY_PX }}>
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <span
              key={h}
              className="absolute right-1.5 -translate-y-1/2 font-mono text-[10.5px] text-text-3"
              style={{ top: h * HOUR_PX }}
            >
              {hhmm(h * 60)}
            </span>
          ))}
        </div>

        {days.map((day) => (
          <DayColumn
            key={day}
            day={day}
            placed={byDay.get(day) ?? []}
            weeklyHours={weeklyHours}
            nowMinutes={day === today ? nowMinutes : null}
            narrow={multi}
            selectedId={selectedId}
            onSelect={onSelect}
            onEmptySlot={onEmptySlot}
          />
        ))}
      </div>
    </div>
  );
}

function DayColumn({
  day,
  placed,
  weeklyHours,
  nowMinutes,
  narrow,
  selectedId,
  onSelect,
  onEmptySlot,
}: {
  day: string;
  placed: Placed[];
  weeklyHours: WeeklyHours;
  nowMinutes: number | null;
  /** Coluna da semana: no celular mede ~90 px. */
  narrow: boolean;
  selectedId: string | null;
  onSelect: (b: Booking) => void;
  onEmptySlot: (day: string, time: string) => void;
}) {
  return (
    <div
      data-day={day}
      className="cal-hours relative isolate cursor-pointer border-l"
      style={{ height: DAY_PX }}
      // Tocar num espaço vazio propõe bloqueá-lo naquela meia hora, como o
      // "criar evento" do Google. Os agendamentos interrompem o clique.
      onClick={(e) => {
        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
        const minutes = Math.min(1410, Math.max(0, Math.floor((y / HOUR_PX) * 2) * 30));
        onEmptySlot(day, hhmm(minutes));
      }}
    >
      {offHoursBands(weeklyHours, day).map((b) => (
        <div
          key={b.startMin}
          aria-hidden
          className="cal-off pointer-events-none absolute inset-x-0"
          style={{ top: (b.startMin / 60) * HOUR_PX + 1, height: ((b.endMin - b.startMin) / 60) * HOUR_PX - 1 }}
        />
      ))}

      {placed.map((p) => (
        <EventBlock
          key={`${p.booking.id}:${p.day}`}
          placed={p}
          narrow={narrow}
          selected={p.booking.id === selectedId}
          onSelect={onSelect}
        />
      ))}

      {nowMinutes !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger"
          style={{ top: (nowMinutes / 60) * HOUR_PX }}
        >
          <span className="absolute -left-[5px] -top-[6px] h-2.5 w-2.5 rounded-full bg-danger" />
        </div>
      )}
    </div>
  );
}

function EventBlock({
  placed,
  narrow,
  selected,
  onSelect,
}: {
  placed: Placed;
  narrow: boolean;
  selected: boolean;
  onSelect: (b: Booking) => void;
}) {
  const { booking: b, startMin, endMin, col, cols } = placed;
  const top = (startMin / 60) * HOUR_PX;
  const height = Math.max(MIN_EVENT_PX, ((endMin - startMin) / 60) * HOUR_PX - 2);
  const title = bookingTitle(b);
  const start = hhmm(startMin);
  const end = hhmm(endMin);
  const range = `${placed.continuesBefore ? "…" : start} – ${placed.continuesAfter ? "…" : end}`;
  // Um agendamento curto cabe numa linha: "Nome, 10:00", como no Google. Se
  // além disso divide a largura, o nome prevalece e a hora fica no painel.
  const compact = height < 36;
  const showTime = !compact || cols === 1;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(b);
      }}
      aria-label={`${title}, ${start} a ${end}`}
      className={cn(
        "absolute z-10 overflow-hidden rounded-[6px] border text-left leading-tight shadow-sm transition-[box-shadow,filter] hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
        cols > 1 ? "px-1" : "px-1.5",
        // Numa linha, a hora que não cabe junto ao nome pula para uma
        // segunda linha que fica oculta: aparece inteira ou não aparece.
        compact ? "flex flex-wrap content-start items-center gap-x-1 text-[11px]" : "py-1 text-[11.5px]",
        bookingTone(b).box,
        selected && "ring-2 ring-brand ring-offset-1 ring-offset-background"
      )}
      style={{
        top: top + 1,
        height,
        left: `calc(${(col / cols) * 100}% + 2px)`,
        width: `calc(${100 / cols}% - 4px)`,
        // A primeira linha, centralizada na altura do agendamento.
        paddingTop: compact ? Math.max(1, (height - 14) / 2) : undefined,
      }}
    >
      <span className="flex min-w-0 max-w-full items-center gap-1 font-semibold">
        {b.source === "ai" && b.kind === "session" && (
          <Sparkles aria-label="Agendó la IA" className="h-3 w-3 shrink-0" strokeWidth={2} />
        )}
        {hasDeliveryIssue(b) && (
          <AlertTriangle aria-label="Sin enlace de la reunión" className="h-3 w-3 shrink-0" strokeWidth={2} />
        )}
        <span className="truncate">
          {b.isTest && "Prueba · "}
          {title}
        </span>
      </span>
      {showTime && (
        <span
          className={cn(
            "font-mono text-[10.5px] opacity-80",
            // Numa linha o nome prevalece. Na semana do celular a hora
            // nem é tentada.
            compact ? cn("shrink-0 whitespace-nowrap", narrow && "hidden sm:inline") : "mt-0.5 block truncate"
          )}
        >
          {compact ? start : range}
        </span>
      )}
    </button>
  );
}
