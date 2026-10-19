"use client";

import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import type {
  AdsBlockDto,
  BotBlockDto,
  HygieneBlockDto,
  SalesBlockDto,
} from "@/lib/analytics";
import { AdsSection } from "./ads-section";
import { BotSection } from "./bot-section";
import { HygieneSection } from "./hygiene-section";
import { defaultRange, RangePicker, type Range } from "./range-picker";
import { SalesSection } from "./sales-section";

type Block<T> = { data: T | null; loading: boolean; error: string | null };

const inicial = <T,>(): Block<T> => ({ data: null, loading: true, error: null });

/**
 * Pede um bloco e o deixa no seu estado. Enquanto chega, MANTÉM o anterior
 * (a seção o atenua): esvaziar a cada mudança de intervalo faria a
 * tela pular. Uma resposta que chega atrasada, de um intervalo que já não é o
 * escolhido, é descartada com o `AbortSignal`.
 */
async function cargar<T>(
  url: string,
  set: (update: (prev: Block<T>) => Block<T>) => void,
  signal: AbortSignal
): Promise<void> {
  set((prev) => ({ ...prev, loading: true, error: null }));
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch {
    if (signal.aborted) return;
    set(() => ({ data: null, loading: false, error: t("results.loadFailed") }));
    return;
  }
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (signal.aborted) return;
  if (!res.ok || !body) {
    set(() => ({
      data: null,
      loading: false,
      error: body?.error?.message ?? "No se pudo calcular este bloque.",
    }));
    return;
  }
  set(() => ({ data: body, loading: false, error: null }));
}

/**
 * 019 — Tela Resultados.
 *
 * Cada bloco carrega por conta própria: são cerca de vinte consultas distribuídas em
 * quatro grupos, e numa única resposta o mais lento atrasaria os três
 * rápidos. Assim a tela desenha em cascata e um bloco quebrado mostra o seu próprio
 * erro sem derrubar o resto.
 */
export function ResultsClient({
  currency,
  agenda,
  today,
  timezone,
}: {
  currency: string;
  agenda: boolean;
  /** Hoje no fuso horário do negócio (`YYYY-MM-DD`), resolvido no servidor. */
  today: string;
  timezone: string;
}) {
  const [range, setRange] = useState<Range>(() => defaultRange(today));
  const [sales, setSales] = useState<Block<SalesBlockDto>>(inicial);
  const [ads, setAds] = useState<Block<AdsBlockDto>>(inicial);
  const [bot, setBot] = useState<Block<BotBlockDto>>(inicial);
  const [hygiene, setHygiene] = useState<Block<HygieneBlockDto>>(inicial);

  useEffect(() => {
    const ctl = new AbortController();
    const q = `from=${range.from}&to=${range.to}`;
    void cargar(`/api/analytics/sales?${q}`, setSales, ctl.signal);
    void cargar(`/api/analytics/ads?${q}`, setAds, ctl.signal);
    void cargar(`/api/analytics/bot?${q}`, setBot, ctl.signal);
    return () => ctl.abort();
  }, [range]);

  // A higiene descreve o AGORA: não depende do intervalo escolhido.
  useEffect(() => {
    const ctl = new AbortController();
    void cargar("/api/analytics/hygiene", setHygiene, ctl.signal);
    return () => ctl.abort();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="min-w-0">
          <h2 className="text-[17px] font-bold tracking-tight">Resultados</h2>
          <p className="text-xs text-text-3">
            Ventas, el trabajo del agente, de dónde llegan y qué se está cayendo.
          </p>
        </div>
        <RangePicker value={range} onChange={setRange} today={today} timezone={timezone} />
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-6">
        <SalesSection {...sales} currency={currency} />
        <AdsSection {...ads} />
        <BotSection {...bot} agenda={agenda} />
        <HygieneSection {...hygiene} currency={currency} />
      </div>
    </div>
  );
}
