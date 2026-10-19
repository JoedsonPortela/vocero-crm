"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { delta, type Comparable, type RateDto } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/** A moldura comum dos cartões de indicador. */
function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-subtle px-3 py-2.5">
      <p className="text-xs font-medium text-text-2">{label}</p>
      {children}
    </div>
  );
}

/**
 * 019 — Cartão de indicador. Todo número comparável vem com o mesmo número
 * do período anterior: sem essa referência, "12 negócios" não diz se o mês vai
 * bem ou mal. A direção é lida pela seta e pelo sinal, não só pela
 * cor.
 */
export function StatCard({
  label,
  value,
  compare,
  hint,
  /** true = subir é pior (negócios perdidos, por exemplo). */
  inverted = false,
}: {
  label: string;
  value: string;
  compare?: Comparable;
  hint?: string;
  inverted?: boolean;
}) {
  const d = compare ? delta(compare) : null;
  const mejor = d === null || d === 0 ? null : inverted ? d < 0 : d > 0;
  const Icon = d === null || d === 0 ? ArrowRight : d > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <Tile label={label}>
      <p className="mt-0.5 truncate text-xl font-semibold">{value}</p>
      {compare && (
        <p
          className={cn(
            "mt-1 flex items-center gap-1 text-xs",
            mejor === null ? "text-text-3" : mejor ? "text-success-text" : "text-danger-text"
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {d === null ? (
            <span>sin base previa ({compare.previous})</span>
          ) : (
            <span>
              {d > 0 ? "+" : ""}
              {d}% vs. {compare.previous} antes
            </span>
          )}
        </p>
      )}
      {hint && <p className="mt-1 text-[11px] text-text-3">{hint}</p>}
    </Tile>
  );
}

/** Cartão de uma taxa: a porcentagem grande e, embaixo, de quantos casos. */
export function RateCard({
  label,
  rate,
  unit,
}: {
  label: string;
  rate: RateDto;
  unit: string;
}) {
  return (
    <Tile label={label}>
      <p className="mt-0.5 text-xl font-semibold">
        {rate.value === null ? "—" : `${rate.value}%`}
      </p>
      <p className="mt-1 text-xs">
        {rate.value === null ? (
          <span className="text-text-3">sin casos en el periodo</span>
        ) : (
          <span className="text-text-3">
            de {rate.sample} {unit}
            {!rate.reliable && " · muestra chica"}
          </span>
        )}
      </p>
    </Tile>
  );
}
