/**
 * 018 — Como a origem é nomeada na tela. Sem dependências de servidor: a
 * usam a lista, o painel, a gaveta do negócio e a fonte do contato.
 *
 * A Meta marca `source_type: "post"` quando o clique veio de uma publicação e não
 * de um anúncio. Chamá-lo de "anúncio" faria passar por pago algo que não foi.
 */
export function etiquetaDeOrigen(sourceType: string | null | undefined): string {
  return sourceType === "post" ? "Publicación" : "Anuncio";
}

/**
 * Conta como origem "anúncio"? Uma publicação é mostrada na bandeja igual,
 * mas não é somada aos anúncios na origem do prospect.
 */
export function cuentaComoAnuncio(
  anuncio: { sourceType: string | null } | null | undefined
): boolean {
  return !!anuncio && anuncio.sourceType !== "post";
}

/** Título a mostrar quando a Meta não enviou nenhum. */
export function titularDeOrigen(
  headline: string | null | undefined,
  sourceType: string | null | undefined
): string {
  if (headline) return headline;
  return sourceType === "post" ? "Publicación sin título" : "Anuncio sin título";
}
