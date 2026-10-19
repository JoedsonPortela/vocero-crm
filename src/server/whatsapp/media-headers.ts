/**
 * #78 — Com quais cabeçalhos um anexo é servido ao navegador
 * (`GET /api/media/{assetId}`).
 *
 * Um anexo é um arquivo que um cliente enviou: conteúdo que não controlamos,
 * servido a partir da mesma origem da sessão do operador. Se o navegador o
 * abrisse como página —um `.html` que diz ser documento, um SVG com um
 * `<script>`, ou um tipo adivinhado a partir dos bytes— rodaria com as
 * cookies do CRM. Três cabeçalhos fecham essa classe de problema inteira, com o
 * mesmo padrão que já usa o ícone da marca
 * (`src/app/api/branding/favicon/route.ts`):
 *
 * - `X-Content-Type-Options: nosniff`: o navegador acredita no tipo declarado
 *   e não o reinterpreta pelo conteúdo.
 * - `Content-Security-Policy: default-src 'none'; sandbox`: mesmo que o tipo
 *   resulte ser um documento, não tem de onde carregar nada nem permissão para
 *   executar scripts, enviar formulários ou abrir janelas.
 * - `Content-Disposition`: `inline` só para o que o navegador pré-visualiza
 *   de forma inerte (imagem, áudio, vídeo, PDF); todo o resto é baixado.
 *
 * Módulo puro (sem BD nem disco) para poder ser testado por unidade; a rota só
 * lê o asset e chama aqui.
 */

/**
 * O que o navegador mostra sem executar nada. Lista fechada: o que não está
 * aqui é baixado, mesmo que seja inofensivo (um `.txt`, um `.csv`).
 */
export const PREVIEWABLE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "video/mp4",
  "video/3gpp",
  "application/pdf",
]);

/**
 * Tipos que um navegador abre como DOCUMENTO com permissão de executar scripts.
 * Não são aceitos como anexo de saída: o WhatsApp não os pré-visualiza e não
 * há caso de negócio que justifique enfiar uma página na origem do CRM.
 */
export const FORBIDDEN_UPLOAD_MIMES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
]);

/** `tipo/subtipo`, com ou sem parâmetros (`; codecs=opus`), só ASCII imprimível. */
const MIME_SHAPE = /^[\w.+-]+\/[\w.+-]+(\s*;[\x20-\x7e]*)?$/;
const MIME_BASE_SHAPE = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * `Audio/OGG; codecs=opus` → `audio/ogg`. A Meta envia os áudios com o codec
 * como parâmetro; pré-visualizar ou não se decide pelo tipo base.
 */
export function baseMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return MIME_BASE_SHAPE.test(base) ? base : null;
}

export function isPreviewable(mime: string | null | undefined): boolean {
  const base = baseMime(mime);
  return base !== null && PREVIEWABLE_MIMES.has(base);
}

export function isForbiddenUploadMime(mime: string | null | undefined): boolean {
  const base = baseMime(mime);
  return base !== null && FORBIDDEN_UPLOAD_MIMES.has(base);
}

/**
 * O `Content-Type` que se declara. Um MIME ausente ou malformado (um asset
 * antigo sem tipo, lixo nos metadados da Meta) sai como
 * `application/octet-stream`, que junto com `nosniff` significa «baixe-o e
 * não o interprete».
 */
export function contentTypeFor(mime: string | null | undefined): string {
  const limpio = (mime ?? "").trim();
  return MIME_SHAPE.test(limpio) ? limpio.toLowerCase() : "application/octet-stream";
}

/**
 * Nome de arquivo apto para o cabeçalho: sem aspas, quebras de linha nem
 * caminhos. O `filename*` mantém acentos e til (RFC 5987) para que
 * «cotação.pdf» seja baixado com seu nome; o `filename` simples é o
 * reserva ASCII.
 */
export function contentDisposition(
  tipo: "inline" | "attachment",
  fileName: string | null | undefined
): string {
  const nombre = (fileName ?? "")
    .replace(/[\/\r\n\t"]/g, "_")
    .trim()
    .slice(0, 150);
  if (!nombre) return tipo;
  const ascii = nombre.replace(/[^\w. -]/g, "_");
  const utf8 = encodeURIComponent(nombre).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Cabeçalhos completos com os quais o binário de um anexo é servido. */
export function mediaResponseHeaders(
  asset: { mimeType: string | null; fileName: string | null },
  byteLength: number
): Record<string, string> {
  const inline = isPreviewable(asset.mimeType);
  return {
    "content-type": contentTypeFor(asset.mimeType),
    "content-length": String(byteLength),
    "content-disposition": contentDisposition(
      inline ? "inline" : "attachment",
      asset.fileName
    ),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    // O conteúdo de um asset é imutável; privado por sessão.
    "cache-control": "private, max-age=86400",
  };
}
