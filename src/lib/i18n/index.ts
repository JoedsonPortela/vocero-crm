import { ptBR } from "./pt-br";

/**
 * Idioma da interface. Hoje só pt-BR: o lang do HTML e os formatos de
 * data, número e moeda saem daqui.
 */
export const LOCALE = "pt-BR";

/** Todas as chaves folha do dicionário, com pontos: `nav.inbox`. */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TextKey = Leaves<typeof ptBR>;

/**
 * Resolve uma chave com pontos no dicionário. Se a chave não existir,
 * devolve a própria chave: um texto faltando aparece na tela e não derruba
 * a página.
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
