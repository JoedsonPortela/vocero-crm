"use client";

import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * 026 — Confirmação de exclusão. É irreversível, então diz com todas as letras
 * o que sai e o que fica — e diz diferente conforme a caixa marcada,
 * porque «também o contato» muda os números de Resultados e isso não se
 * adivinha.
 */
export function DeleteConversationDialog({
  contactName,
  onCancel,
  onConfirm,
}: {
  contactName: string;
  onCancel: () => void;
  /** Devolve a mensagem de erro, ou null se foi excluído. */
  onConfirm: (alsoContact: boolean) => Promise<string | null>;
}) {
  const [alsoContact, setAlsoContact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape cancela, como em qualquer diálogo. Enter NÃO confirma: excluir para
  // nunca pode acontecer com uma tecla solta.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function confirm() {
    setBusy(true);
    setError(null);
    const problema = await onConfirm(alsoContact);
    // Se deu certo, quem abriu o diálogo já o fechou: não há estado a tocar.
    if (problema) {
      setError(problema);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("inbox.deleteTitle")}
        className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 font-semibold">{t("inbox.deleteQuestion")}</h3>
        <p className="mb-3 text-[13px] leading-relaxed text-text-2">
          Se borran los mensajes con {contactName}, sus adjuntos, la ficha y lo
          que el agente recuerda de esta conversación. Si vuelve a escribir, el
          agente empieza de cero.
        </p>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-subtle p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--danger)]"
            checked={alsoContact}
            disabled={busy}
            onChange={(e) => setAlsoContact(e.target.checked)}
          />
          <span className="text-[13px] leading-snug">
            <span className="font-medium">{t("inbox.alsoContact")}</span>
            <span className="mt-0.5 block text-xs text-text-3">
              {alsoContact
                ? t("inbox.deleteAlsoDetail")
                : "Sin marcar, el contacto conserva sus notas, su etapa y sus citas."}
            </span>
          </span>
        </label>

        <p className="mt-3 text-xs font-medium text-danger-text">{t("inbox.cannotUndo")}</p>

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger-soft bg-danger-tint p-2.5 text-xs text-danger-text"
          >
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy
              ? "Eliminando…"
              : alsoContact
                ? t("inbox.deleteBoth")
                : t("inbox.deleteTitle")}
          </Button>
        </div>
      </div>
    </div>
  );
}
