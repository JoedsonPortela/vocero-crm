import type { FichaDto, FichaValue } from "./types";

/**
 * Apresentação da ficha do lead.
 *
 * As chaves são inventadas por quem qualifica — um bot, ou o dono digitando —,
 * então chegam como `dolor_principal`, `dolorPrincipal` ou `dolor-principal`. Aqui
 * são lidas de forma bonita SEM tocar no que está salvo: renomear a chave quebraria o agente,
 * que a busca pelo nome exato.
 */

/** `dolor_principal` → `Dolor principal`. Não modifica o dado, só como ele aparece. */
export function fichaLabel(key: string): string {
  const palabras = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!palabras) return key;
  return palabras.charAt(0).toUpperCase() + palabras.slice(1);
}

/** Como um valor é mostrado. Os booleanos em Sim/Não: ninguém qualifica com `true`. */
export function fichaValueText(value: FichaValue): string {
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return String(value);
  return value ?? "";
}

const SI = new Set(["si", "sí", "true", "1"]);
const NO = new Set(["no", "false", "0"]);

/**
 * O que o dono digita, de volta a um valor gravável.
 *
 * Regra: **editar não muda o tipo do dado** a menos que o que foi escrito já não seja
 * desse tipo. Se o agente salvou `presupuesto: 50000` (número) e o dono
 * corrige para "60000", salva-se 60000 e não "60000" — porque do outro lado há
 * um bot que pode estar comparando, e converter em silêncio um número em texto
 * é daquelas mudanças que só se descobrem quando algo já falhou.
 */
export function parseFichaValue(
  text: string,
  previous: FichaValue | undefined
): FichaValue {
  const t = text.trim();
  if (typeof previous === "boolean") {
    if (SI.has(t.toLowerCase())) return true;
    if (NO.has(t.toLowerCase())) return false;
    return t;
  }
  if (typeof previous === "number") {
    const n = Number(t);
    if (t !== "" && Number.isFinite(n)) return n;
    return t;
  }
  return t;
}

/** Chaves ordenadas para que a ficha não mude de posição entre recarregamentos. */
export function fichaEntries(ficha: FichaDto): [string, FichaValue][] {
  return Object.entries(ficha).sort(([a], [b]) => a.localeCompare(b, "es"));
}
