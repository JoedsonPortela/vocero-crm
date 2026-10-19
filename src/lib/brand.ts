/**
 * A marca Vocero — a mesma de vocerocrm.com.
 *
 * Vive aqui, sem React, porque a usam dois mundos: os componentes (o traço
 * do painel lateral e do login) e o servidor (o favicon gerado que é
 * servido como texto). Ter o desenho em um só lugar é o que garante que
 * a aba e a barra lateral mostrem o MESMO "v".
 *
 * O traço é um "v" caligráfico fluido com remate ciano. O corpo é pintado
 * com `currentColor` (assim herda o acento white-label); o remate é uma
 * constante da marca e NÃO é recalculado com o acento: é o que a torna
 * reconhecível.
 */

/** Corpo do "v": é pintado com a cor do contexto. */
export const BRAND_MARK_BODY =
  "M4 5c2 8 5 14.5 7.8 14.7 2.3.2 3.7-4.1 4.7-8.2";

/** Remate curto, sempre ciano. */
export const BRAND_MARK_TAIL = "M16.5 11.5c.8-3 2-5.5 4-6.1";

export const BRAND_MARK_STROKE = 3.4;

/** Ciano sobre fundos claros (texto azul ao lado). */
export const BRAND_CYAN = "#00c6f5";

/** Ciano sobre o mosaico azul: um ponto mais claro para não afundar. */
export const BRAND_CYAN_ON_TILE = "#3fdcff";

/**
 * Esta instância se chama Vocero? Só então o logo é desenhado: uma
 * agência que renomeou o CRM para o seu cliente não deve ver o "v" de outro
 * produto na sua barra lateral nem na sua aba. O nome padrão é
 * "Vocero", então uma instância não configurada o vê de imediato.
 */
export function isVoceroName(name: string): boolean {
  return name.trim().toLowerCase() === "vocero";
}
