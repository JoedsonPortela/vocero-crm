"use client";

import { t } from "@/lib/i18n";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Trash2 } from "lucide-react";
import type { Branding } from "@/lib/branding";
import {
  faviconHref,
  FAVICON_MIMES,
  MAX_FAVICON_BYTES,
} from "@/lib/favicon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * O ícone da aba.
 *
 * Uma pré-visualização é SEMPRE mostrada: sem logo enviado, a do ícone gerado
 * com a inicial e o acento. Assim fica claro que a instância já tem um e
 * que enviar algo é substituí-lo, não estreá-lo.
 */
export function FaviconCard({ branding }: { branding: Branding }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Muda a cada carga para que a pré-visualização não fique com a anterior.
  const [rev, setRev] = useState(0);
  const [actual, setActual] = useState(branding.favicon);

  const src = `${faviconHref({ ...branding, favicon: actual })}&r=${rev}`;

  async function subir(file: File) {
    setError(null);
    if (file.size > MAX_FAVICON_BYTES) {
      setError(
        `El icono no puede pasar de ${Math.round(MAX_FAVICON_BYTES / 1024)} KB.`
      );
      return;
    }
    setSubiendo(true);
    const res = await fetch("/api/settings/branding/favicon", {
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }).catch(() => null);
    setSubiendo(false);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "Não foi possível enviar o ícone");
      return;
    }
    const data = (await res.json()) as { favicon: Branding["favicon"] };
    setActual(data.favicon);
    setRev((v) => v + 1);
    router.refresh(); // o layout raiz volta a emitir o <link rel="icon">
  }

  async function quitar() {
    setError(null);
    setSubiendo(true);
    const res = await fetch("/api/settings/branding/favicon", {
      method: "DELETE",
    }).catch(() => null);
    setSubiendo(false);
    if (!res?.ok) {
      setError("Não foi possível remover o ícone");
      return;
    }
    setActual(null);
    setRev((v) => v + 1);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo do negócio</CardTitle>
        <p className="text-sm text-text-3">
          Aparece na aba do navegador e na barra lateral do CRM.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          {/* Sem next/image de propósito: é um arquivo servido por uma rota
              própria, de 64 px e já otimizado. Passá-lo pelo otimizador
              seria trabalho de servidor sem ganho nenhum. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={t("settings.iconPreview")}
            width={48}
            height={48}
            className="h-12 w-12 rounded-lg border bg-card object-contain"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {actual ? "Logo próprio" : "Gerado com a sua marca"}
            </p>
            <p className="mt-0.5 text-xs text-text-3">
              {actual
                ? t("settings.faviconHint")
                : "A inicial sobre a sua cor de destaque. Envie seu logo para substituí-la."}
            </p>
          </div>
        </div>

        <input
          ref={input}
          type="file"
          accept={FAVICON_MIMES.join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Limpa-se o valor para que enviar o MESMO arquivo duas vezes
            // dispare o evento de novo.
            e.target.value = "";
            if (f) void subir(f);
          }}
        />

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={subiendo}
            onClick={() => input.current?.click()}
          >
            <ImageUp className="h-4 w-4" />
            {subiendo ? "Enviando…" : actual ? "Trocar logo" : "Enviar logo"}
          </Button>
          {actual && (
            <Button variant="ghost" disabled={subiendo} onClick={() => void quitar()}>
              <Trash2 className="h-4 w-4" /> Remover
            </Button>
          )}
        </div>

        <p className="text-xs text-text-3">
          PNG, SVG, ICO, JPEG ou WebP, até{" "}
          {Math.round(MAX_FAVICON_BYTES / 1024)} KB. Quadrado e com fundo
          transparente fica melhor: é desenhado sobre a sua cor de destaque.
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
