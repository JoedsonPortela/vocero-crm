"use client";

import { t } from "@/lib/i18n";
import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fichaEntries, fichaLabel, fichaValueText, parseFichaValue } from "@/lib/ficha";
import type { FichaDto, FichaValue } from "@/lib/types";

/**
 * O que se sabe do lead, onde se trabalha a conversa.
 *
 * Existe porque `PUT /api/bot/ficha` já deixa o agente guardar o que
 * descobre: sem esta tela, isso era uma gaveta que enchia e nunca era aberta.
 *
 * Pode ser corrigido à mão. Um dado errado que o dono vê mas não consegue
 * consertar é pior do que não tê-lo: ensina a desconfiar de toda a ficha.
 */
export function FichaPanel({
  ficha,
  onSave,
}: {
  ficha: FichaDto;
  /** Patch: só o que muda. `null` apaga a chave. */
  onSave: (patch: Record<string, FichaValue | null>) => Promise<void>;
}) {
  const [editando, setEditando] = useState<string | null>(null);
  const [borrador, setBorrador] = useState("");
  const [agregando, setAgregando] = useState(false);
  const [claveNueva, setClaveNueva] = useState("");
  const [valorNuevo, setValorNuevo] = useState("");
  const [guardando, setGuardando] = useState(false);

  const entradas = fichaEntries(ficha);

  async function guardar(patch: Record<string, FichaValue | null>) {
    setGuardando(true);
    try {
      await onSave(patch);
    } finally {
      setGuardando(false);
    }
  }

  async function confirmarEdicion(clave: string) {
    const valor = parseFichaValue(borrador, ficha[clave]);
    setEditando(null);
    // Vazio não apaga: para isso existe a lixeira. Um campo que é esvaziado
    // sozinho, porque alguém selecionou e saiu, leva um dado que custou uma
    // conversa.
    if (valor === "" || valor === ficha[clave]) return;
    await guardar({ [clave]: valor });
  }

  async function agregar() {
    const clave = claveNueva.trim();
    const valor = valorNuevo.trim();
    if (!clave || !valor) return;
    setAgregando(false);
    setClaveNueva("");
    setValorNuevo("");
    await guardar({ [clave]: valor });
  }

  return (
    <section className="border-b p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="kicker">
          Ficha
        </p>
        {!agregando && (
          <button
            onClick={() => setAgregando(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Agregar
          </button>
        )}
      </div>

      {entradas.length === 0 && !agregando && (
        <p className="text-xs leading-relaxed text-text-3">
          Todavía vacía. Aquí aparece lo que tu agente va averiguando del lead
          mientras conversa — y puedes escribirlo tú.
        </p>
      )}

      {entradas.length > 0 && (
        <dl className="space-y-1.5">
          {entradas.map(([clave, valor]) => (
            <div key={clave} className="group flex items-start gap-2 text-xs">
              <dt className="w-[38%] shrink-0 pt-1 text-text-3">
                {fichaLabel(clave)}
              </dt>
              <dd className="flex min-w-0 flex-1 items-start gap-1">
                {editando === clave ? (
                  <>
                    <Input
                      autoFocus
                      value={borrador}
                      onChange={(e) => setBorrador(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void confirmarEdicion(clave);
                        if (e.key === "Escape") setEditando(null);
                      }}
                      className="h-7 py-0 text-xs"
                      aria-label={`Valor de ${fichaLabel(clave)}`}
                    />
                    <button
                      onClick={() => void confirmarEdicion(clave)}
                      aria-label={t("common.save")}
                      className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setEditando(null)}
                      aria-label="Cancelar"
                      className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setEditando(clave);
                        setBorrador(fichaValueText(valor));
                      }}
                      className="min-w-0 flex-1 break-words rounded px-1 py-1 text-left hover:bg-accent"
                      aria-label={`Editar ${fichaLabel(clave)}`}
                    >
                      {fichaValueText(valor)}
                    </button>
                    <span className="flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        onClick={() => setEditando(clave)}
                        aria-label={`Editar ${fichaLabel(clave)}`}
                        className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        disabled={guardando}
                        onClick={() => void guardar({ [clave]: null })}
                        aria-label={`Quitar ${fichaLabel(clave)}`}
                        className="rounded p-1 text-text-3 hover:bg-accent hover:text-danger"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {agregando && (
        <div className="mt-2 space-y-1.5">
          <Input
            autoFocus
            value={claveNueva}
            onChange={(e) => setClaveNueva(e.target.value)}
            placeholder={t("ficha.namePlaceholder")}
            className="h-7 py-0 text-xs"
            aria-label={t("ficha.nameLabel")}
          />
          <Input
            value={valorNuevo}
            onChange={(e) => setValorNuevo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void agregar();
              if (e.key === "Escape") setAgregando(false);
            }}
            placeholder={t("ficha.value")}
            className="h-7 py-0 text-xs"
            aria-label={t("ficha.valueLabel")}
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={!claveNueva.trim() || !valorNuevo.trim() || guardando}
              onClick={() => void agregar()}
            >
              Agregar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAgregando(false);
                setClaveNueva("");
                setValorNuevo("");
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
