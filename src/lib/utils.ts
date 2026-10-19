import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Iniciais (máx. 2) para o avatar de um contato. */
export function initials(name: string): string {
  // 028 — A primeira letra ou número de cada palavra. Os nomes do Instagram e
  // do Facebook trazem emojis («Kevin Belier 🐏», «Vivir con virtud ⚖️»): pegar o
  // primeiro caractere partia o emoji ao meio («K�») ou o usava como inicial.
  const parts = name
    .trim()
    .split(/\s+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((c): c is string => Boolean(c));
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  return (first + second).toUpperCase();
}

/* Paleta dos avatares do mockup da landing (hsl(h 62% 52%)): tons
   médios saturados, legíveis com inicial branca nos dois temas. */
const AVATAR_COLORS = [
  "bg-[#3985d1]", // azul
  "bg-[#d17139]", // terracota
  "bg-[#9e39d1]", // violeta
  "bg-[#30a657]", // verde
  "bg-[#ce3b6c]", // framboesa
  "bg-[#b67c20]", // âmbar
  "bg-[#30a6a6]", // turquesa
  "bg-[#6954d4]", // índigo
] as const;

/** Cor estável por contato: hash simples do id/telefone → mesma classe sempre. */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

export function formatPhone(phone: string | null | undefined): string {
  // 003: contatos BSUID podem não ter telefone.
  return phone ? `+${phone}` : "Sin teléfono";
}
