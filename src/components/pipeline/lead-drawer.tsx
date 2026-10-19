"use client";

import { t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MessageSquareText, X } from "lucide-react";
import type {
  AnuncioDto,
  FichaDto,
  FichaValue,
  PriorityValue,
  StageDto,
} from "@/lib/types";
import { formatMoneyCents, parseMoneyToCents } from "@/lib/money";
import { cn, formatPhone } from "@/lib/utils";
import { AnuncioOrigen } from "@/components/anuncio-origen";
import { ContactAvatar } from "@/components/avatar";
import { FichaPanel } from "@/components/ficha-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PriorityPicker } from "./priority-picker";
import type { BoardLead } from "./pipeline-client";

/**
 * O negócio, aberto, sem sair do painel.
 *
 * Antes o clique num cartão não fazia nada: para ver de quem era era preciso
 * ir à bandeja e voltar, e revisando uma coluna de quinze isso dá trinta
 * viagens. A gaveta responde a pergunta "quem é e como está?" no lugar
 * onde ela é feita.
 */
export function LeadDrawer({
  lead,
  stages,
  currency,
  onClose,
  onMoveStage,
  onAmount,
  onPriority,
}: {
  lead: BoardLead;
  stages: StageDto[];
  /** Moeda do negócio, para o lead que ainda não tem a sua. */
  currency: string;
  onClose: () => void;
  /** Passa pelo mesmo caminho do arrasto: perder exige motivo. */
  onMoveStage: (stageId: string) => void;
  onAmount: (cents: number | null) => void;
  onPriority: (value: PriorityValue | null) => void;
}) {
  const [ficha, setFicha] = useState<FichaDto>({});
  // 018: de qual anúncio veio; null se escreveu por conta própria.
  const [anuncio, setAnuncio] = useState<AnuncioDto | null>(null);
  const [monto, setMonto] = useState("");
  const [editandoMonto, setEditandoMonto] = useState(false);

  const contactId = lead.contact.id;
  const moneda = lead.currency ?? currency;

  const cargarFicha = useCallback(async () => {
    const detail = await fetch(`/api/contacts/${contactId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    setFicha(detail?.contact?.ficha ?? {});
    setAnuncio(detail?.anuncio ?? null);
  }, [contactId]);

  // Ao abrir outro negócio não pode aparecer o anúncio do anterior.
  useEffect(() => setAnuncio(null), [contactId]);

  useEffect(() => {
    setEditandoMonto(false);
    setMonto(lead.amountCents === null ? "" : (lead.amountCents / 100).toFixed(2));
    void cargarFicha();
  }, [cargarFicha, lead.amountCents]);

  // Escape fecha: uma gaveta que só fecha com o mouse atrapalha quem
  // revisa o painel com o teclado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function guardarFicha(patch: Record<string, FichaValue | null>) {
    setFicha((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next;
    });
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ficha: patch }),
    }).catch(() => null);
    void cargarFicha();
  }

  const montoParseado = monto.trim() ? parseMoneyToCents(monto) : null;
  const montoInvalido = monto.trim().length > 0 && montoParseado === null;

  return (
    <>
      {/* Véu: fechar tocando fora é o que se tenta primeiro. */}
      <button
        aria-label={t("pipeline.closeDeal")}
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-overlay"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Trato de ${lead.contact.name}`}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(360px,92vw)] flex-col border-l bg-popover shadow-pop"
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="kicker text-text-2">
            Trato
          </h3>
          <button
            onClick={onClose}
            aria-label={t("pipeline.closeDealPanel")}
            className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {/* Quem */}
          <section className="border-b p-4">
            <div className="flex items-center gap-3">
              <ContactAvatar
                name={lead.contact.name}
                seed={lead.contact.id}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-[650]">{lead.contact.name}</p>
                <p className="text-xs text-text-3">
                  {formatPhone(lead.contact.phone)}
                </p>
              </div>
            </div>

            {lead.conversationId ? (
              <Link
                href={`/inbox?contact=${lead.contact.id}`}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border bg-secondary px-3 py-2 text-sm font-medium hover:bg-accent"
              >
                <MessageSquareText className="h-4 w-4" /> Abrir conversación
              </Link>
            ) : (
              <p className="mt-3 text-xs text-text-3">
                Todavía no hay conversación con este contacto.
              </p>
            )}

            {anuncio && (
              <div className="mt-3">
                <AnuncioOrigen anuncio={anuncio} />
              </div>
            )}
          </section>

          {/* Quanto */}
          <section className="border-b p-4">
            <p className="mb-2 kicker">
              Monto ({moneda})
            </p>
            {editandoMonto ? (
              <>
                <Input
                  autoFocus
                  value={monto}
                  onChange={(e) => setMonto(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !montoInvalido) {
                      setEditandoMonto(false);
                      onAmount(montoParseado);
                    }
                    if (e.key === "Escape") setEditandoMonto(false);
                  }}
                  placeholder="12,500"
                  aria-label={t("pipeline.dealAmount")}
                  className="h-8 text-sm"
                />
                <p className="mt-1 text-xs text-text-3">
                  {montoInvalido
                    ? "No se entiende ese importe."
                    : montoParseado === null
                      ? t("pipeline.clearAmountHint")
                      : `Se guardará como ${formatMoneyCents(montoParseado, moneda)}`}
                </p>
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={montoInvalido}
                    onClick={() => {
                      setEditandoMonto(false);
                      onAmount(montoParseado);
                    }}
                  >
                    Guardar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditandoMonto(false)}
                  >
                    Cancelar
                  </Button>
                </div>
              </>
            ) : (
              <button
                onClick={() => setEditandoMonto(true)}
                aria-label={t("pipeline.editAmount")}
                className={cn(
                  "w-full rounded px-1 py-1 text-left text-sm tabular-nums hover:bg-accent",
                  lead.amountCents === null
                    ? "text-text-3"
                    : "font-semibold text-foreground"
                )}
              >
                {lead.amountCents === null
                  ? t("pipeline.noAmount")
                  : formatMoneyCents(lead.amountCents, moneda)}
              </button>
            )}
          </section>

          {/* Para quem ligar primeiro */}
          <section className="border-b p-4">
            <p className="mb-2 kicker">
              Prioridad
            </p>
            <PriorityPicker value={lead.priority} onChange={onPriority} />
          </section>

          {/* Onde fica */}
          <section className="border-b p-4">
            <p className="mb-2 kicker">
              Etapa
            </p>
            <div className="flex flex-wrap gap-1.5">
              {stages.map((s) => {
                const actual = s.id === lead.stageId;
                return (
                  <button
                    key={s.id}
                    onClick={() => !actual && onMoveStage(s.id)}
                    aria-pressed={actual}
                    aria-label={`Mover a ${s.name}`}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      actual
                        ? "border-brand bg-brand-tint font-semibold text-brand-text"
                        : "border-border text-text-2 hover:bg-accent"
                    )}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </section>

          {/* O que se sabe */}
          <FichaPanel ficha={ficha} onSave={guardarFicha} />
        </div>
      </aside>
    </>
  );
}
