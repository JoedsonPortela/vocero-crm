"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export type TimePoint = {
  bucket: string;
  value: number;
  /** O que diz o tooltip dessa barra, depois do valor. */
  detail?: string;
};

/**
 * 019 — Uma série no tempo, em barras. UMA grandeza por gráfico: o Cloud
 * desenhava prospects (barras) e dinheiro (linha) com duas escalas no mesmo
 * espaço, e dois eixos num gráfico fazem o olho comparar alturas que não
 * são comparáveis. Aqui são dois gráficos, cada um com sua escala.
 *
 * HTML e não SVG escalado: com `viewBox` o texto encolhe com a largura e num
 * celular as datas ficavam com 5 px. As barras medem no máximo 24 px,
 * arredondadas em cima e retas na base; o valor de cada uma aparece ao passar
 * o ponteiro, e a tabela equivalente fica para o leitor de tela.
 */
export function TimeBars({
  title,
  points,
  format,
  unit,
  emptyText = "Sin movimientos en el periodo.",
}: {
  title: string;
  points: TimePoint[];
  format: (v: number) => string;
  /** O que a série conta, para a tabela acessível ("prospectos", "ventas"). */
  unit: string;
  emptyText?: string;
}) {
  const [activo, setActivo] = useState<number | null>(null);
  const max = Math.max(0, ...points.map((p) => p.value));
  const tope = escalaLimpia(max);
  const n = points.length;
  const total = points.reduce((a, p) => a + p.value, 0);
  const cada = Math.max(1, Math.ceil(n / 6));

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-text-2">{title}</span>
        <span className="text-xs text-text-3">
          {format(total)} en el periodo
        </span>
      </figcaption>

      {max === 0 ? (
        <p className="flex h-36 items-center justify-center rounded-md border border-dashed text-sm text-text-3">
          {emptyText}
        </p>
      ) : (
        <>
          <div
            className="relative mt-3 h-36"
            onPointerLeave={() => setActivo(null)}
            aria-hidden
          >
            {/* Uma única referência de escala, discreta: o topo e a base. */}
            <div className="absolute inset-x-0 top-0 border-t border-border" />
            <span className="absolute right-0 top-0 -translate-y-full pb-0.5 text-[10px] leading-none text-text-3">
              {format(tope)}
            </span>
            <div className="absolute inset-x-0 bottom-0 border-t border-border-strong" />

            <div className="absolute inset-0 flex items-end">
              {points.map((p, i) => (
                <div
                  key={p.bucket}
                  className="flex h-full min-w-0 flex-1 items-end justify-center"
                  onPointerEnter={() => setActivo(i)}
                  onPointerDown={() => setActivo(i)}
                >
                  {p.value > 0 && (
                    <div
                      className={cn(
                        "w-[70%] max-w-[24px] rounded-t-[4px] bg-brand transition-opacity",
                        activo !== null && activo !== i && "opacity-45"
                      )}
                      style={{ height: `${Math.max(2, (p.value / tope) * 100)}%` }}
                    />
                  )}
                </div>
              ))}
            </div>

            {activo !== null && points[activo] && (
              <Tooltip
                point={points[activo]}
                index={activo}
                n={n}
                bottomPct={(points[activo].value / tope) * 100}
                format={format}
              />
            )}
          </div>

          <div className="relative mt-1 h-4 text-[11px] text-text-3" aria-hidden>
            {points.map((p, i) =>
              i % cada === 0 ? (
                <span
                  key={p.bucket}
                  className="absolute top-0 whitespace-nowrap"
                  style={anclaje(i, n)}
                >
                  {etiqueta(p.bucket)}
                </span>
              ) : null
            )}
          </div>

          <table className="sr-only">
            <caption>{title}</caption>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">{unit}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.bucket}>
                  <td>{etiqueta(p.bucket)}</td>
                  <td>
                    {format(p.value)}
                    {p.detail ? ` · ${p.detail}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}

function Tooltip({
  point,
  index,
  n,
  bottomPct,
  format,
}: {
  point: TimePoint;
  index: number;
  n: number;
  bottomPct: number;
  format: (v: number) => string;
}) {
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border-strong bg-popover px-2 py-1 text-xs shadow-md"
      style={{ ...anclaje(index, n), bottom: `calc(${Math.min(bottomPct, 100)}% + 6px)` }}
    >
      <strong className="font-semibold text-foreground">{format(point.value)}</strong>
      {point.detail && <span className="text-text-2"> · {point.detail}</span>}
      <span className="text-text-3"> · {etiqueta(point.bucket)}</span>
    </div>
  );
}

/**
 * Onde se ancora algo que fica sobre a barra `i` de `n`: centralizado, exceto nas
 * bordas, onde é empurrado para dentro para não sair do cartão (e não
 * alargar a página no celular).
 */
function anclaje(i: number, n: number): React.CSSProperties {
  const centro = ((i + 0.5) / n) * 100;
  if (centro < 15) return { left: `${(i / n) * 100}%` };
  if (centro > 85) return { right: `${((n - i - 1) / n) * 100}%` };
  return { left: `${centro}%`, transform: "translateX(-50%)" };
}

/**
 * O topo da escala, arredondado para um número limpo (1, 2, 5 × 10ⁿ) que
 * cobre o máximo: uma referência de "37" não se lê; uma de "40", sim.
 */
export function escalaLimpia(max: number): number {
  if (max <= 0) return 1;
  const potencia = 10 ** Math.floor(Math.log10(max));
  for (const paso of [1, 2, 2.5, 5, 10]) {
    if (paso * potencia >= max) return paso * potencia;
  }
  return 10 * potencia;
}

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** `2026-08-13` → `13 ago` · `2026-08` → `ago 26`. */
export function etiqueta(bucket: string): string {
  const partes = bucket.split("-");
  const mes = MESES[Number(partes[1]) - 1] ?? "";
  if (partes.length === 2) return `${mes} ${partes[0]!.slice(2)}`;
  return `${Number(partes[2])} ${mes}`;
}
