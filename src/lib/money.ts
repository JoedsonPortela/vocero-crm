/**
 * Dinheiro. Vive em `lib/` (não em `server/`) porque o painel soma as suas colunas
 * no cliente e não pode arrastar o BD para o bundle.
 *
 * Tudo em CENTAVOS INTEIROS, também no cálculo: somar pesos em ponto flutuante
 * dá totais que o dono não consegue bater com os próprios cartões.
 *
 * A moeda NÃO está fixada. Cada instância escolhe a sua em Ajustes → Marca,
 * e todas as funções a recebem explicitamente: um padrão global escondido
 * faria uma instalação fora do seu país somar errado sem avisar.
 */

/**
 * Moedas ISO-4217 que um negócio pode escolher, agrupadas para o seletor.
 *
 * Cobre o México, a América Central e do Sul, o Caribe hispânico, os EUA e a Espanha, e
 * os países que os cercam, para que uma instalação em outro país não tenha
 * que esperar alguém acrescentar a sua moeda. Os países dolarizados (Equador,
 * El Salvador, Porto Rico) usam USD, e o Panamá pode escolher USD ou balboa.
 * Adicionar uma é acrescentar uma linha: nada no BD restringe o código.
 */
export const CURRENCY_OPTIONS = [
  { code: "MXN", name: "Peso mexicano", where: "México", group: "latam" },
  { code: "GTQ", name: "Quetzal", where: "Guatemala", group: "latam" },
  { code: "HNL", name: "Lempira", where: "Honduras", group: "latam" },
  { code: "NIO", name: "Córdoba", where: "Nicarágua", group: "latam" },
  { code: "CRC", name: "Colón costarriquenho", where: "Costa Rica", group: "latam" },
  { code: "PAB", name: "Balboa", where: "Panamá", group: "latam" },
  { code: "BZD", name: "Dólar belizenho", where: "Belize", group: "latam" },
  { code: "DOP", name: "Peso dominicano", where: "República Dominicana", group: "latam" },
  { code: "CUP", name: "Peso cubano", where: "Cuba", group: "latam" },
  { code: "HTG", name: "Gourde", where: "Haiti", group: "latam" },
  { code: "JMD", name: "Dólar jamaicano", where: "Jamaica", group: "latam" },
  { code: "TTD", name: "Dólar de Trinidad e Tobago", where: "Trinidad y Tobago", group: "latam" },
  { code: "COP", name: "Peso colombiano", where: "Colômbia", group: "latam" },
  { code: "VES", name: "Bolívar", where: "Venezuela", group: "latam" },
  { code: "PEN", name: "Sol", where: "Peru", group: "latam" },
  { code: "BOB", name: "Boliviano", where: "Bolívia", group: "latam" },
  { code: "CLP", name: "Peso chileno", where: "Chile", group: "latam" },
  { code: "ARS", name: "Peso argentino", where: "Argentina", group: "latam" },
  { code: "UYU", name: "Peso uruguaio", where: "Uruguai", group: "latam" },
  { code: "PYG", name: "Guarani", where: "Paraguai", group: "latam" },
  { code: "BRL", name: "Real", where: "Brasil", group: "latam" },
  { code: "USD", name: "Dólar americano", where: "EUA, Equador, El Salvador, Porto Rico, Panamá", group: "norte" },
  { code: "CAD", name: "Dólar canadense", where: "Canadá", group: "norte" },
  { code: "EUR", name: "Euro", where: "Espanha e zona do euro", group: "europa" },
  { code: "GBP", name: "Libra esterlina", where: "Reino Unido", group: "europa" },
  { code: "CHF", name: "Franco suíço", where: "Suíça", group: "europa" },
  { code: "XAF", name: "Franco CFA", where: "Guiné Equatorial", group: "otras" },
  { code: "AUD", name: "Dólar australiano", where: "Austrália", group: "otras" },
  { code: "JPY", name: "Iene", where: "Japão", group: "otras" },
] as const;

export const CURRENCY_GROUPS = [
  { id: "latam", label: "América Latina e Caribe" },
  { id: "norte", label: "América do Norte" },
  { id: "europa", label: "Europa" },
  { id: "otras", label: "Outras" },
] as const;

export type Currency = (typeof CURRENCY_OPTIONS)[number]["code"];

export const CURRENCIES = CURRENCY_OPTIONS.map((c) => c.code) as [
  Currency,
  ...Currency[],
];

export const DEFAULT_CURRENCY: Currency = "MXN";

export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && (CURRENCIES as readonly string[]).includes(v);
}

/**
 * Este valor entra no total da sua coluna? Só soma o que está na
 * moeda do negócio: converter exigiria uma taxa de câmbio, e um CRM que
 * inventa taxas de câmbio mente. O que fica de fora é CONTADO à parte para
 * poder dizer isso na tela, em vez de fazê-lo desaparecer.
 */
export function sumable(
  amount: { amountCents: number | null; currency: string | null },
  businessCurrency: string
): boolean {
  if (amount.amountCents === null) return false;
  return (amount.currency ?? businessCurrency) === businessCurrency;
}

/** Dinheiro para exibir. Recebe centavos porque é assim que trafega e como é guardado. */
export function formatMoneyCents(
  cents: number | null | undefined,
  currency: string,
  locale = "es-MX"
): string | null {
  if (cents === null || cents === undefined) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // Moeda ou locale que o runtime não conhece: melhor um número correto sem
    // símbolo do que uma tela quebrada.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Texto livre do dono → centavos. Aceita "12,500.50", "12500", "$12 500".
 * Devolve `null` se não houver um número reconhecível, para não guardar um 0 que
 * depois seja lido como "não vale nada".
 */
export function parseMoneyToCents(input: string): number | null {
  const limpio = input.replace(/[^\d.,-]/g, "").trim();
  if (!limpio) return null;
  // O último separador vale como decimal; o resto são de milhares.
  const ultimoPunto = limpio.lastIndexOf(".");
  const ultimaComa = limpio.lastIndexOf(",");
  const corte = Math.max(ultimoPunto, ultimaComa);
  let entero = limpio;
  let decimales = "";
  if (corte !== -1 && limpio.length - corte <= 3) {
    entero = limpio.slice(0, corte);
    decimales = limpio.slice(corte + 1);
  }
  const soloDigitos = entero.replace(/[^\d-]/g, "");
  if (!soloDigitos || soloDigitos === "-") return null;
  const cents =
    Number(soloDigitos) * 100 + Number((decimales + "00").slice(0, 2)) *
      (soloDigitos.startsWith("-") ? -1 : 1);
  return Number.isFinite(cents) ? Math.trunc(cents) : null;
}
