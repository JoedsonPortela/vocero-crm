import { DEFAULT_CURRENCY, isCurrency, type Currency } from "@/lib/money";

/**
 * White-label: nome do CRM, acento e moeda por organização.
 * Predefinições sóbrias do sistema Atlas; para uma cor personalizada são derivados
 * hover/soft/tint/text e a tinta por cima (branca ou quase preta) passa AA.
 */

export type AccentSet = {
  accent: string;
  hover: string;
  soft: string;
  tint: string;
  text: string;
  /** Tinta legível POR CIMA do acento (botões, badges). */
  fg: string;
};

/** O acento é derivado de forma diferente conforme o tema ativo. */
export type ThemeMode = "light" | "dark";

/**
 * Ícone enviado. Somente o tipo e uma versão: o binário fica no volume de
 * mídia, porque `organization.metadata` é lido em CADA renderização de página e
 * colocar ali um arquivo em base64 faria pagar esse peso em todas.
 */
export type BrandingFavicon = {
  mime: string;
  /**
   * Carimbo de tempo do carregamento. É o que faz o navegador soltar o
   * ícone anterior. Não é um contador de propósito: ao remover o ícone não fica
   * onde lembrar qual estava em uso, e reiniciar em 1 repetiria uma URL já
   * armazenada em cache com OUTRO logo dentro.
   */
  version: number;
};

export type Branding = {
  name: string;
  accent: string; // hex do acento base escolhido
  /** Moeda do negócio: a única que o painel soma. */
  currency: Currency;
  /** `null` = é desenhado com a inicial sobre o acento (ver `lib/favicon`). */
  favicon: BrandingFavicon | null;
};

export const DEFAULT_BRANDING: Branding = {
  name: "Vocero",
  // O azul elétrico do vocerocrm.com: a instância recém-instalada aparece
  // igual à landing. Uma agência a muda em Configuração → Marca.
  accent: "#0d5bff",
  currency: DEFAULT_CURRENCY,
  favicon: null,
};

/**
 * Predefinições. A primeira é a marca Vocero (valores exatos da landing); as
 * demais são os tons sóbrios do handoff Atlas, que continuam disponíveis para
 * quem quiser um CRM mais discreto.
 */
export const ACCENT_PRESETS: Record<string, { label: string; set: AccentSet }> = {
  "#0d5bff": {
    label: "Azul Vocero",
    set: { accent: "#0d5bff", hover: "#0a4de6", soft: "#d3e2ff", tint: "#ebf1ff", text: "#0038d8", fg: "#ffffff" },
  },
  "#3f5972": {
    label: "Azul aço",
    set: { accent: "#3f5972", hover: "#334a60", soft: "#dde5ee", tint: "#f3f6f9", text: "#2b4056", fg: "#ffffff" },
  },
  "#4b5563": {
    label: "Grafito",
    set: { accent: "#4b5563", hover: "#3b4350", soft: "#e2e5ea", tint: "#f4f5f7", text: "#333a45", fg: "#ffffff" },
  },
  "#3f6b66": {
    label: "Verde apagado",
    set: { accent: "#3f6b66", hover: "#335752", soft: "#dcebe8", tint: "#f2f8f6", text: "#2b4a46", fg: "#ffffff" },
  },
  "#5f5470": {
    label: "Ameixa",
    set: { accent: "#5f5470", hover: "#4d4459", soft: "#e6e1ec", tint: "#f6f4f8", text: "#443c52", fg: "#ffffff" },
  },
};

type Rgb = { r: number; g: number; b: number };

export function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function hexToRgb(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mistura `color` em direção a `target` na proporção t (0..1). */
function mix(color: Rgb, target: Rgb, t: number): Rgb {
  return {
    r: color.r + (target.r - color.r) * t,
    g: color.g + (target.g - color.g) * t,
    b: color.b + (target.b - color.b) * t,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Luminância relativa (WCAG). */
function luminance({ r, g, b }: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contraste WCAG entre duas cores. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Fundo de referência do tema escuro (deve seguir `--bg` de globals.css). */
const DARK_BG: Rgb = { r: 0x1c, g: 0x26, b: 0x3c };

/**
 * Fundo de referência da barra lateral (deve seguir `--bg` de `.nav-dark`).
 * A barra é azul-marinho fixo nos dois temas, então o seu acento é calculado
 * contra ela e não contra a página: se seguisse DARK_BG, trocar o tema
 * escuro repintaria também a barra do tema claro.
 */
const NAV_BG: Rgb = { r: 0x0b, g: 0x13, b: 0x27 };

/** Tinta POR CIMA do acento: branco só se passar AA (4.5:1), senão, quase preto. */
const INK_ON_LIGHT = "#0f1419";
const INK: Rgb = hexToRgb(INK_ON_LIGHT);
function inkOn(base: Rgb): string {
  return contrast(base, WHITE) >= 4.5 ? "#ffffff" : INK_ON_LIGHT;
}
/**
 * Alguma das duas tintas passa AA? Nos tons médios (branco entre 4.1 e
 * 4.5:1) nenhuma chega, então o preenchimento continua sendo ajustado: clareia
 * no escuro (até a tinta quase preta passar) e escurece no claro.
 */
function inkPasses(base: Rgb): boolean {
  return contrast(base, WHITE) >= 4.5 || contrast(base, INK) >= 4.5;
}

/**
 * Receita de um acento sobre fundo escuro. `minContrast` é o do preenchimento
 * contra o fundo (botão, barra de seleção: 3:1 basta para o que não é
 * texto; o acento como TEXTO usa `text`, ver --accent-ink); `soft`/`tint`
 * são o quanto afundam em direção ao fundo, e `text` o quanto a tinta é clareada,
 * que além disso é elevada até 4.5:1 sobre o tint.
 */
type DarkRecipe = { bg: Rgb; minContrast: number; soft: number; tint: number; text: number };

// Página escura: com 3:1 o azul Vocero mantém a tinta branca (4.5:1); o
// tint mais denso (0.78) faz a linha selecionada aparecer sem ilegibilidade da cor
// do texto (≥ 1.25:1 contra o fundo).
const PAGE_DARK: DarkRecipe = { bg: DARK_BG, minContrast: 3, soft: 0.64, tint: 0.78, text: 0.34 };
// Barra lateral: a receita de sempre, para que apareça igual a antes.
const NAV_DARK: DarkRecipe = { bg: NAV_BG, minContrast: 3.5, soft: 0.72, tint: 0.88, text: 0.28 };

function darkAccentSet(accentHex: string, r: DarkRecipe): AccentSet {
  let base = hexToRgb(
    isValidHex(accentHex) ? accentHex.toLowerCase() : DEFAULT_BRANDING.accent
  );
  while (
    (contrast(base, r.bg) < r.minContrast || !inkPasses(base)) &&
    luminance(base) < 0.95
  ) {
    base = mix(base, WHITE, 0.1);
  }
  const tint = mix(base, r.bg, r.tint);
  let text = mix(base, WHITE, r.text);
  while (contrast(text, tint) < 4.5 && luminance(text) < 0.95) {
    text = mix(text, WHITE, 0.1);
  }
  return {
    accent: rgbToHex(base),
    hover: rgbToHex(mix(base, WHITE, 0.16)),
    soft: rgbToHex(mix(base, r.bg, r.soft)),
    tint: rgbToHex(tint),
    text: rgbToHex(text),
    fg: inkOn(base),
  };
}

/**
 * Conjunto completo para qualquer acento, conforme o tema.
 *
 * Claro: predefinição exata se existir; senão é derivado misturando em direção ao branco, e uma base
 * clara demais é escurecida até contraste ≥ 3:1 com o fundo branco.
 * A tinta por cima é branca só se passar AA; em um acento claro (um verde, um
 * amarelo) fica quase preta.
 *
 * Escuro: as predefinições NÃO se aplicam — um acento pensado para fundo branco
 * afunda no fundo escuro. É clareado até se destacar do fundo e as
 * variantes soft/tint são misturadas em direção ao fundo escuro, não ao branco.
 */
export function resolveAccentSet(
  accentHex: string,
  mode: ThemeMode = "light"
): AccentSet {
  if (mode === "dark") return darkAccentSet(accentHex, PAGE_DARK);

  const preset = ACCENT_PRESETS[accentHex.toLowerCase()];
  if (preset) return preset.set;
  if (!isValidHex(accentHex)) return ACCENT_PRESETS[DEFAULT_BRANDING.accent]!.set;

  let base = hexToRgb(accentHex.toLowerCase());
  // contraste com branco = (1.05) / (L + 0.05); exigir ≥ 3
  while (1.05 / (luminance(base) + 0.05) < 3 && luminance(base) > 0.005) {
    base = mix(base, BLACK, 0.12);
  }
  while (!inkPasses(base) && luminance(base) > 0.005) {
    base = mix(base, BLACK, 0.12);
  }
  return {
    accent: rgbToHex(base),
    hover: rgbToHex(mix(base, BLACK, 0.16)),
    soft: rgbToHex(mix(base, WHITE, 0.82)),
    tint: rgbToHex(mix(base, WHITE, 0.94)),
    text: rgbToHex(mix(base, BLACK, 0.28)),
    fg: inkOn(base),
  };
}

/** O acento da barra lateral azul-marinho (`.nav-dark`), em qualquer tema. */
export function resolveNavAccentSet(accentHex: string): AccentSet {
  return darkAccentSet(accentHex, NAV_DARK);
}

function accentBlock(selector: string, s: AccentSet): string {
  return `${selector}{--accent:${s.accent};--accent-hover:${s.hover};--accent-soft:${s.soft};--accent-tint:${s.tint};--accent-text:${s.text};--accent-fg:${s.fg};}`;
}

/**
 * CSS de variáveis para injetar no <head> (SSR, sem flash). Emite os DOIS
 * temas mesmo que o servidor já saiba qual está ativo: o botão de tema troca
 * `data-theme` no cliente sem recarregar, então o CSS do outro tema tem
 * que estar presente desde a primeira pintura.
 *
 * O seletor é duplicado (`:root:root`) de propósito: assim ganha em
 * especificidade dos blocos de globals.css sem depender da ordem de carregamento.
 *
 * O terceiro bloco (`.nav-dark`) é a sidebar: azul-marinho sem importar
 * `data-theme`, então o seu acento é SEMPRE calculado contra o seu próprio fundo
 * (`NAV_BG`, ver `resolveNavAccentSet`), e não com o que esteja ativo no resto
 * da página. Por ser declarado diretamente sobre o `<aside>` (não sobre
 * `:root`), vence para esse elemento e seus filhos sem competir em especificidade
 * com os outros dois blocos, que só tocam `<html>`.
 */
export function accentCssVariables(accentHex: string): string {
  return (
    accentBlock(":root:root", resolveAccentSet(accentHex, "light")) +
    accentBlock(
      ':root:root[data-theme="dark"]',
      resolveAccentSet(accentHex, "dark")
    ) +
    accentBlock(".nav-dark", resolveNavAccentSet(accentHex))
  );
}

export function normalizeBranding(input: Partial<Branding> | null): Branding {
  const name = input?.name?.trim().slice(0, 30) || DEFAULT_BRANDING.name;
  const accent =
    input?.accent && isValidHex(input.accent)
      ? input.accent.toLowerCase()
      : DEFAULT_BRANDING.accent;
  const currency = isCurrency(input?.currency)
    ? input.currency
    : DEFAULT_BRANDING.currency;
  // O ícone não é tocado pelo formulário de marca: é enviado e removido pela
  // sua própria rota. Um PUT de nome/cor não deve apagá-lo por reflexo.
  const f = input?.favicon;
  const favicon =
    f && typeof f.mime === "string" && Number.isFinite(f.version)
      ? { mime: f.mime, version: Math.max(1, Math.floor(f.version)) }
      : null;
  return { name, accent, currency, favicon };
}
