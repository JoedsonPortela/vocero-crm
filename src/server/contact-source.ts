import type { SourceDto, SourceValue } from "@/lib/types";

/**
 * Fonte do prospecto.
 *
 * O que o dono captura VALE; o que não, é marcado como deduzido. Por isso
 * `contact.source` nasce NULL: ninguém precisa capturar à mão a fonte dos
 * centenas de contatos que já existiam, nem marcá-los falsamente com um backfill.
 * A UI distingue as duas coisas para não apresentar uma suposição como um dado.
 */

export const SOURCE_VALUES: readonly SourceValue[] = [
  "anuncio",
  "organico",
  "referido",
  "conocido",
  "otro",
];

export const SOURCE_LABELS: Record<SourceValue | "desconocida", string> = {
  anuncio: "Anuncio",
  organico: "Contenido orgánico",
  referido: "Referido",
  conocido: "Conocido",
  otro: "Otro",
  desconocida: "Sin identificar",
};

export function isSourceValue(v: unknown): v is SourceValue {
  return typeof v === "string" && SOURCE_VALUES.includes(v as SourceValue);
}

/**
 * Um contato que chegou só pelo WhatsApp não diz de onde saiu, e o CRM não
 * o inventa: fica "sem identificar" até que alguém o capture.
 *
 * 018 — Salvo se a Meta tiver dito: se a conversa foi aberta por um anúncio,
 * a fonte é DEDUZIDA como "anúncio". O capturado à mão continua valendo.
 */
export function effectiveSource(
  stored: SourceValue | null,
  llegoPorAnuncio = false
): SourceDto {
  if (stored) return { value: stored, source: "capturada" };
  if (llegoPorAnuncio) return { value: "anuncio", source: "deducida" };
  return { value: "desconocida", source: "deducida" };
}
