import {
  BRAND_CYAN_ON_TILE,
  BRAND_MARK_BODY,
  BRAND_MARK_STROKE,
  BRAND_MARK_TAIL,
  isVoceroName,
} from "./brand";
import { resolveAccentSet, type Branding } from "./branding";

/**
 * O ícone da aba, white-label.
 *
 * Toda instância tem um **sem configurar nada**: se chamar Vocero, é o
 * logo da marca (o "v" com remate ciano sobre o mosaico azul, igual ao de
 * vocerocrm.com); com outro nome desenha-se a inicial sobre o acento. Uma
 * agência que implanta para o seu cliente pode enviar o logo real e
 * substituí-lo.
 *
 * Que exista uma reserva gerada não é enfeite: sem ela, quem não envia nada
 * fica com o ícone genérico do navegador, e com cinco instâncias abertas
 * em abas todas parecem iguais.
 */

/**
 * Nome fixo dentro do volume de mídia: uma organização tem um só
 * ícone. Vive aqui e não na rota que o serve porque o Next só admite
 * handlers como exports de um `route.ts` — qualquer outra coisa quebra o build.
 */
export const FAVICON_ASSET = "favicon";

/** O que o navegador aceita como ícone e que sabemos verificar. */
export const FAVICON_MIMES = [
  "image/png",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/jpeg",
  "image/webp",
] as const;

export type FaviconMime = (typeof FAVICON_MIMES)[number];

/**
 * 256 KB. Um favicon maior não existe; o limite está para que ninguém use este
 * campo como armazenamento de arquivos.
 */
export const MAX_FAVICON_BYTES = 256 * 1024;

export function isFaviconMime(value: string): value is FaviconMime {
  return (FAVICON_MIMES as readonly string[]).includes(value);
}

/**
 * O que o arquivo É DE VERDADE, segundo os seus primeiros bytes.
 *
 * Não se confia no `content-type` enviado pelo cliente: declarar `image/png`
 * e enviar um HTML é a forma clássica de passar um documento onde se espera
 * uma imagem. Devolve null se não reconhecer o formato — e aí não é salvo.
 */
export function sniffFaviconMime(bytes: Uint8Array): FaviconMime | null {
  const at = (i: number) => bytes[i];

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  // ICO: 00 00 01 00
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x01 && at(3) === 0x00) {
    return "image/x-icon";
  }
  // WEBP: "RIFF" .... "WEBP"
  const ascii = (i: number, s: string) =>
    [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";

  // SVG: é texto. Aceita-se com ou sem declaração XML ou comentários à frente.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 1024))
    .trimStart();
  if (/^<(\?xml|!--|svg)[\s>]/i.test(head) && /<svg[\s>]/i.test(head)) {
    return "image/svg+xml";
  }

  return null;
}

/** Inicial que é desenhada. Vazio ou estranho cai no V do Vocero. */
export function faviconInitial(name: string): string {
  const c = name.trim().charAt(0).toUpperCase();
  return c || "V";
}

/**
 * O ícone gerado. SVG e não PNG de propósito: desenha nítido em qualquer
 * densidade, pesa centenas de bytes e não precisa de nenhuma biblioteca de imagem no
 * servidor.
 */
export function generatedFaviconSvg(branding: Branding): string {
  const { accent, hover, fg } = resolveAccentSet(branding.accent);
  if (isVoceroName(branding.name)) return voceroFaviconSvg(accent, hover);
  const letra = faviconInitial(branding.name)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`,
    `<rect width="64" height="64" rx="12" fill="${accent}"/>`,
    `<text x="32" y="33" fill="${fg}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif"`,
    ` font-size="38" font-weight="700" text-anchor="middle" dominant-baseline="central">${letra}</text>`,
    `</svg>`,
  ].join("");
}

/**
 * O favicon do vocerocrm.com, com o degradê no acento da instância:
 * uma instância chamada Vocero mas com outra cor continua vendo SUA cor.
 * O traço vem de `lib/brand`, o mesmo que desenha a barra lateral.
 */
function voceroFaviconSvg(from: string, to: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>`,
    `</linearGradient></defs>`,
    `<rect width="64" height="64" rx="14" fill="url(#g)"/>`,
    `<g transform="translate(5.6 5.6) scale(2.2)" fill="none" stroke-linecap="round">`,
    `<path d="${BRAND_MARK_BODY}" stroke="#ffffff" stroke-width="${BRAND_MARK_STROKE}"/>`,
    `<path d="${BRAND_MARK_TAIL}" stroke="${BRAND_CYAN_ON_TILE}" stroke-width="${BRAND_MARK_STROKE}"/>`,
    `</g></svg>`,
  ].join("");
}

/**
 * Sufixo de cache do ícone.
 *
 * Os navegadores guardam o favicon com uma teimosia notável: sem que a
 * URL mude, o logo novo pode demorar dias para aparecer. Para o enviado vai
 * o número da versão; para o gerado, um hash do nome e do acento, que
 * são justamente o que o muda.
 */
export function faviconCacheKey(
  branding: Pick<Branding, "name" | "accent" | "favicon">
): string {
  if (branding.favicon) return `u${branding.favicon.version}`;
  let h = 0;
  const semilla = `${branding.name}|${branding.accent}`;
  for (let i = 0; i < semilla.length; i++) {
    h = (h * 31 + semilla.charCodeAt(i)) >>> 0;
  }
  return `g${h.toString(36)}`;
}

/** URL que vai no `<link rel="icon">`. */
export function faviconHref(
  branding: Pick<Branding, "name" | "accent" | "favicon">
): string {
  return `/api/branding/favicon?v=${faviconCacheKey(branding)}`;
}
