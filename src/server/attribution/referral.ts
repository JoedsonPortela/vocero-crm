import type { WebhookReferral } from "@/server/inbox/webhook";

/**
 * 018 — Do `referral` do WhatsApp a UM anúncio de origem.
 *
 * Puro de propósito: testa-se sem banco de dados, e é a única porta pela qual
 * um payload externo chega a uma coluna. Tem que aguentar entradas
 * hostis, não só as bonitas da documentação da Meta.
 *
 * Só WhatsApp por enquanto (spec 018, D3). Instagram e Messenger enviam outra
 * forma (`ad_id`, `ads_context_data`) e terão a própria função ao lado de
 * esta, com a mesma saída.
 */

export type AnuncioDeOrigen = {
  sourceId: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  ctwaClid: string | null;
  /** De onde baixar a imagem do criativo; valida-se antes de usá-la. */
  imageUrl: string | null;
  /** O referral recortado, para não perder campos que a Meta acrescentar depois. */
  raw: Record<string, unknown>;
};

/**
 * Limites do que é guardado. O payload da Meta é curto, mas nada impede que
 * um webhook traga um título de um megabyte, e isso não precisa acabar na
 * base.
 */
export const COTAS = {
  id: 128,
  titular: 300,
  texto: 2000,
  url: 2048,
  /** Tamanho máximo do `raw` serializado. */
  raw: 8_000,
} as const;

/** Chaves de primeiro nível que são mantidas em `raw`. */
const CLAVES_WHATSAPP = [
  "source_url",
  "source_id",
  "source_type",
  "headline",
  "body",
  "media_type",
  "image_url",
  "video_url",
  "thumbnail_url",
  "ctwa_clid",
] as const;

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Texto útil recortado, ou null. Qualquer coisa que não seja texto não conta. */
function texto(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const limpio = v.trim();
  if (!limpio) return null;
  return limpio.length > max ? limpio.slice(0, max) : limpio;
}

/**
 * Só URLs http(s) completas: um `javascript:` jamais chega a um href. O http
 * passa aqui porque o wa-mock serve seus criativos assim; o download e o cartão
 * filtram de novo (https e hosts da Meta).
 */
function url(v: unknown): string | null {
  const t = texto(v, COTAS.url);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function recortarCampos(
  origen: Record<string, unknown>,
  claves: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of claves) {
    const v = texto(origen[k], k.endsWith("_url") ? COTAS.url : COTAS.texto);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Se, mesmo recortado, o `raw` exceder o limite, fica-se com o que identifica o
 * anúncio. Com limites por campo isso não deveria acontecer, mas o limite total é o que
 * se promete.
 */
function acotarRaw(raw: Record<string, unknown>, esencial: Record<string, unknown>) {
  return JSON.stringify(raw).length <= COTAS.raw ? raw : esencial;
}

/** WhatsApp Cloud API: `messages[].referral`. */
export function anuncioDeWhatsapp(referral: unknown): AnuncioDeOrigen | null {
  if (!esObjeto(referral)) return null;
  const r = referral as WebhookReferral & Record<string, unknown>;

  const sourceId = texto(r.source_id, COTAS.id);
  const ctwaClid = texto(r.ctwa_clid, COTAS.texto);
  const headline = texto(r.headline, COTAS.titular);
  const sourceUrl = url(r.source_url);
  // Sem nada que identifique o anúncio não há nada a mostrar.
  if (!sourceId && !ctwaClid && !headline && !sourceUrl) return null;

  const raw = recortarCampos(r, CLAVES_WHATSAPP);
  return {
    sourceId,
    sourceType: texto(r.source_type, COTAS.id),
    sourceUrl,
    headline,
    body: texto(r.body, COTAS.texto),
    mediaType: texto(r.media_type, COTAS.id),
    ctwaClid,
    // A miniatura pesa menos; `image_url` é o criativo completo.
    imageUrl: url(r.thumbnail_url) ?? url(r.image_url),
    raw: acotarRaw(raw, { source_id: sourceId, headline }),
  };
}

/**
 * 018 (D2) — Sem a bandeira `ATRIBUCION`, o anúncio é guardado sem o seu
 * identificador de clique: nem na coluna nem dentro do `raw`. Uma instância que
 * não atribui não acumula identificadores da Meta "por via das dúvidas" (016).
 */
export function sinIdentificadorDeClic(anuncio: AnuncioDeOrigen): AnuncioDeOrigen {
  const raw = { ...anuncio.raw };
  delete raw.ctwa_clid;
  return { ...anuncio, ctwaClid: null, raw };
}
