import { ptBR } from "./pt-br";

/**
 * Idioma de la interfaz. Hoy solo pt-BR: el lang del HTML y los formatos de
 * fecha, número y moneda salen de aquí.
 */
export const LOCALE = "pt-BR";

/** Todas las claves hoja del diccionario, con puntos: `nav.inbox`. */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TextKey = Leaves<typeof ptBR>;

/**
 * Resuelve una clave con puntos en el diccionario. Si la clave no existe,
 * devuelve la clave misma: un texto faltante se nota en pantalla y no tumba
 * la página.
 */
export function t(key: TextKey, vars?: Record<string, string | number>): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, ptBR);
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`
  );
}
