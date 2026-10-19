/**
 * Variáveis posicionais {{n}} do corpo de um modelo do WhatsApp.
 * Puro e sem dependências: usam-no tanto o serviço do servidor como a UI
 * (que precisa saber quantos campos desenhar antes de enviar).
 */

const VARIABLE_REGEX = /\{\{\s*(\d+)\s*\}\}/g;

/** Máximo de parâmetros posicionais por corpo que a Meta aceita. */
export const MAX_TEMPLATE_VARIABLES = 10;

/** Índices distintos de {{n}} presentes no corpo, ordenados. */
function variableIndexes(body: string): number[] {
  const found = new Set<number>();
  for (const m of body.matchAll(VARIABLE_REGEX)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * Quantos parâmetros o corpo exige = o índice mais alto. Com a numeração
 * validada (1..N sem saltos) equivale ao número de variáveis distintas.
 */
export function countVariables(body: string): number {
  const indexes = variableIndexes(body);
  return indexes.length ? indexes[indexes.length - 1]! : 0;
}

/**
 * A Meta aceita várias variáveis por corpo, mas exige numeração posicional
 * contígua a partir de {{1}}: um salto ({{1}} e {{3}}) é uma rejeição certa.
 */
export function validateBodyVariables(body: string): string | null {
  const indexes = variableIndexes(body);
  if (indexes.length === 0) return null;
  if (indexes.length > MAX_TEMPLATE_VARIABLES) {
    return `El cuerpo admite hasta ${MAX_TEMPLATE_VARIABLES} variables`;
  }
  for (let i = 0; i < indexes.length; i++) {
    if (indexes[i] !== i + 1) {
      return `Las variables deben ir numeradas {{1}}, {{2}}, … sin saltos (falta {{${i + 1}}})`;
    }
  }
  return null;
}

/**
 * O que costuma fazer a Meta rejeitar um modelo mesmo com as variáveis
 * numeradas corretamente. Não bloqueia o envio — a Meta decide —, só avisa antes
 * de esperar horas por uma rejeição previsível.
 */
export function templateWarnings(body: string): string[] {
  const text = body.trim();
  if (!text) return [];
  const warnings: string[] = [];
  if (/^\{\{\s*\d+\s*\}\}/.test(text)) {
    warnings.push("Empieza con una variable: Meta suele rechazarlas. Pon un saludo antes, p. ej. «Hola {{1}}».");
  }
  if (/\{\{\s*\d+\s*\}\}[\s.!?¡¿]*$/.test(text)) {
    warnings.push("Termina con una variable: Meta suele rechazarlas. Añade una frase después.");
  }
  if (/\}\}\s*\{\{/.test(text)) {
    warnings.push("Hay dos variables juntas: sepáralas con texto.");
  }
  const variables = countVariables(text);
  const words = text.replace(VARIABLE_REGEX, " ").split(/\s+/).filter(Boolean).length;
  if (variables > 0 && words < variables * 3) {
    warnings.push("Tiene muchas variables para lo corto del mensaje: Meta pide más texto fijo alrededor.");
  }
  return warnings;
}

/** Substitui {{n}} por `variables[n-1]` (vazio se não houver valor). */
export function renderBody(body: string, variables: string[] = []): string {
  return body.replace(VARIABLE_REGEX, (_match, index: string) => {
    return variables[Number(index) - 1] ?? "";
  });
}
