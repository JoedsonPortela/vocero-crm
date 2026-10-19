/**
 * Correspondência de busca tolerante, compartilhada por Bandeja e Contatos.
 *
 * Duas regras nascidas do uso real:
 * 1. Sem acentos nem maiúsculas — "jose" encontra "José".
 * 2. O telefone é comparado por DÍGITOS: a UI o desenha "+52 555 000 1234" e
 *    o BD o guarda "525550001234", então digitar o número como aparece
 *    (ou colá-lo com espaços/traços/parênteses) não encontrava nada.
 */

const DIACRITICS = /[̀-ͯ]/g;

export function normalizeText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(DIACRITICS, "");
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Mínimo de dígitos para tratar a consulta como telefone: um "1" solto
 * casaria com metade do diretório.
 */
const MIN_PHONE_DIGITS = 3;

export function matchesQuery(
  query: string,
  fields: { text?: (string | null | undefined)[]; phone?: string | null }
): boolean {
  const q = normalizeText(query.trim());
  if (!q) return true;

  const inText = (fields.text ?? []).some(
    (value) => value != null && normalizeText(value).includes(q)
  );
  if (inText) return true;

  const queryDigits = digitsOnly(query);
  if (queryDigits.length < MIN_PHONE_DIGITS || !fields.phone) return false;
  return digitsOnly(fields.phone).includes(queryDigits);
}
