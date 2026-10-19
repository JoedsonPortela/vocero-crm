"use client";

import { t } from "@/lib/i18n";
import { useState } from "react";
import {
  PROBLEM_LABELS,
  readImportFile,
  type ImportProblem,
  type ImportRow,
} from "@/lib/contact-import";
import { formatPhone } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Preview = { valid: ImportRow[]; problems: ImportProblem[]; total: number };
type Result = { created: number; existing: number; paused: number };

/**
 * Importar uma lista que já existe em outro lugar (clientes, membros de uma
 * comunidade, um export de contatos). O arquivo é lido no navegador para
 * mostrar o que vai entrar ANTES de gravar qualquer coisa: um CSV malfeito é
 * descoberto na pré-visualização, não com duzentos contatos lixo criados.
 */
export function ImportContactsDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [aiPaused, setAiPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function leer(file: File | undefined) {
    setError(null);
    setPreview(null);
    setResult(null);
    if (!file) return;
    setFileName(file.name);
    const read = readImportFile(await file.text());
    if (!read.ok) {
      setError(read.error);
      return;
    }
    setPreview({ valid: read.valid, problems: read.problems, total: read.total });
  }

  async function importar() {
    if (!preview) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/contacts/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contacts: preview.valid, aiPaused }),
    }).catch(() => null);
    setSaving(false);
    const data = (await res?.json().catch(() => null)) as
      | (Result & { error?: { message?: string } })
      | null;
    if (!res?.ok || !data) {
      setError(data?.error?.message ?? t("contacts.importFailed"));
      return;
    }
    setResult({ created: data.created, existing: data.existing, paused: data.paused });
    onImported();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t("contacts.importTitle")}
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 font-semibold">{t("contacts.importTitle")}</h3>
        <p className="mb-4 text-xs text-text-3">
          Un archivo CSV con una columna <strong>nombre</strong> y una{" "}
          <strong>telefono</strong> en el primer renglón. El teléfono va con
          código de país (52 para México). A quien ya exista no se le duplica ni
          se le cambia el nombre.
        </p>

        {result ? (
          <div className="space-y-1 rounded-md border border-success-soft bg-success-tint px-3 py-2.5 text-[13px] text-success-text">
            <p>
              <strong>{result.created}</strong>{" "}
              {result.created === 1 ? "contato novo" : "contatos novos"}
              {result.existing > 0 && (
                <>
                  {" "}
                  · <strong>{result.existing}</strong> ya{" "}
                  {result.existing === 1 ? t("contacts.existed") : t("contacts.existedPlural")}
                </>
              )}
              .
            </p>
            {result.paused > 0 && (
              <p>
                El agente quedó apagado para <strong>{result.paused}</strong>.
              </p>
            )}
          </div>
        ) : (
          <>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              aria-label={t("contacts.csvFile")}
              onChange={(e) => void leer(e.target.files?.[0])}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm"
            />

            {preview && (
              <div className="mt-4 space-y-3">
                <p className="text-sm">
                  <strong>{preview.valid.length}</strong> de {preview.total}{" "}
                  renglones de <span className="text-text-3">{fileName}</span>{" "}
                  se pueden importar.
                </p>

                {preview.valid.length > 0 && (
                  <ul className="rounded-md border text-xs">
                    {preview.valid.slice(0, 5).map((r) => (
                      <li
                        key={r.phone}
                        className="flex justify-between gap-3 border-b px-3 py-1.5 last:border-b-0"
                      >
                        <span className="truncate">{r.name}</span>
                        <span className="shrink-0 text-text-3">
                          {formatPhone(r.phone)}
                        </span>
                      </li>
                    ))}
                    {preview.valid.length > 5 && (
                      <li className="px-3 py-1.5 text-text-3">
                        … y {preview.valid.length - 5} más
                      </li>
                    )}
                  </ul>
                )}

                {preview.problems.length > 0 && (
                  <details className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
                    <summary className="cursor-pointer">
                      {preview.problems.length}{" "}
                      {preview.problems.length === 1
                        ? t("contacts.rowOut")
                        : "renglones se quedan fuera"}
                    </summary>
                    <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto">
                      {preview.problems.map((p) => (
                        <li key={p.line}>
                          Renglón {p.line}
                          {p.name ? ` (${p.name})` : ""}: {PROBLEM_LABELS[p.reason]}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={aiPaused}
                    onChange={(e) => setAiPaused(e.target.checked)}
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    El agente no les responde
                    <span className="block text-[11px] text-text-3">
                      Para clientes o miembros que quieres atender tú. Sus
                      mensajes llegan a la Bandeja sin que el agente conteste.
                      Aplica también a los que ya existían.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </>
        )}

        {error && <p className="mt-3 text-xs text-danger-text">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {result ? "Fechar" : "Cancelar"}
          </Button>
          {!result && (
            <Button
              disabled={!preview || preview.valid.length === 0 || saving}
              onClick={() => void importar()}
            >
              {saving
                ? "Importando…"
                : preview && preview.valid.length > 0
                  ? `Importar ${preview.valid.length}`
                  : "Importar"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
