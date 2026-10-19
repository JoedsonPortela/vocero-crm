"use client";

import { t } from "@/lib/i18n";
import { useState } from "react";
import { ExternalLink, Megaphone } from "lucide-react";
import type { AnuncioDto } from "@/lib/types";
import { etiquetaDeOrigen, titularDeOrigen } from "@/lib/anuncios";

/**
 * 019 — Miniatura do criativo para listas e tabelas (Resultados). Sem imagem,
 * ou se deixar de ser servida, fica o megafone no mesmo espaço para que as linhas
 * não se mexam.
 */
export function MiniaturaDeAnuncio({
  imageAssetId,
  alt,
}: {
  imageAssetId: string | null;
  alt: string;
}) {
  const [rota, setRota] = useState(false);
  if (!imageAssetId || rota) {
    return (
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded border bg-subtle text-text-3"
        aria-hidden
      >
        <Megaphone className="h-4 w-4" strokeWidth={1.7} />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- anexo privado servido com sessão; não há host que otimizar
    <img
      src={`/api/media/${imageAssetId}`}
      alt={alt}
      loading="lazy"
      onError={() => setRota(true)}
      className="h-9 w-9 shrink-0 rounded border bg-background object-cover"
    />
  );
}

/**
 * 018 — De qual anúncio esta pessoa veio.
 *
 * O mesmo cartão na Bandeja e na gaveta do negócio: a pergunta "quem
 * a trouxe?" é feita nos dois lugares. Aparece inteiro ou não aparece: uma conversa
 * orgânica não mostra um espaço vazio.
 *
 * Só o que a Meta envia no `referral`: o nome do anúncio, a campanha ou
 * o conjunto não vêm ali, e pedi-los exigiria a API de Marketing.
 */
export function AnuncioOrigen({ anuncio }: { anuncio: AnuncioDto }) {
  // A imagem pode não estar (expirou antes de ser copiada, host não permitido) ou
  // deixar de ser servida: o cartão continua mostrando o essencial sem ela.
  const [imagenRota, setImagenRota] = useState(false);
  const etiqueta = etiquetaDeOrigen(anuncio.sourceType);
  const titular = titularDeOrigen(anuncio.headline, anuncio.sourceType);
  const fecha = new Date(anuncio.capturedAt).toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div
      className="rounded-md border border-info-soft bg-info-tint px-3 py-2.5"
      data-anuncio-origen={anuncio.sourceId ?? ""}
    >
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-info-text">
        <Megaphone className="h-4 w-4 shrink-0" strokeWidth={1.7} />
        {etiqueta === "Anuncio" ? t("anuncio.fromAd") : t("anuncio.fromPost")}
      </p>

      <div className="mt-2 flex items-start gap-2.5">
        {anuncio.imageAssetId && !imagenRota && (
          // eslint-disable-next-line @next/next/no-img-element -- anexo privado servido com sessão; não há host que otimizar
          <img
            src={`/api/media/${anuncio.imageAssetId}`}
            alt={`Creativo: ${titular}`}
            loading="lazy"
            onError={() => setImagenRota(true)}
            className="h-14 w-14 shrink-0 rounded border border-info-soft bg-background object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13px] font-semibold leading-snug text-foreground">
            {titular}
          </p>
          {anuncio.body && (
            <p className="mt-0.5 line-clamp-3 break-words text-xs text-text-2">
              {anuncio.body}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 space-y-0.5 text-[11px] text-text-3">
        <p>
          Primer mensaje · {fecha}
          {anuncio.mediaType === "video" ? " · con video" : ""}
        </p>
        {anuncio.sourceId && (
          <p className="truncate font-mono" title={anuncio.sourceId}>
            ID {anuncio.sourceId}
          </p>
        )}
        {/* Só a presença, e só numa instância que atribui: o valor
            do identificador de clique não sai do servidor. */}
        {anuncio.hasCtwaClid && <p>{t("anuncio.clickIdentified")}</p>}
      </div>

      {anuncio.sourceUrl && (
        <a
          href={anuncio.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-text underline underline-offset-2 hover:text-brand"
        >
          Ver {etiqueta.toLowerCase()}
          <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
        </a>
      )}
    </div>
  );
}
