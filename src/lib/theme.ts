/**
 * Tema claro/escuro. A preferência é POR DISPOSITIVO (cookie), não por
 * organização nem por usuário no BD: quem trabalha à noite não a impõe à
 * sua equipe, e não é preciso migração.
 *
 * Sem piscar e sem script de inicialização: a preferência é SEMPRE explícita,
 * então o layout raiz escreve `data-theme` no HTML do servidor e a primeira
 * pintura já chega com o tema correto.
 *
 * Não há opção "seguir o sistema" de propósito: o CRM é usado a jornada toda
 * e uma troca automática ao anoitecer surpreende no meio de uma conversa.
 */

export const THEME_COOKIE = "vocero-theme";
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type ThemePreference = "light" | "dark";
/** O tema que de fato está pintado no DOM. Hoje coincide sempre com a
 *  preferência; é nomeado à parte porque quem o lê (a pré-visualização do
 *  acento) pergunta pelo pintado, não pelo salvo. */
export type ResolvedTheme = ThemePreference;

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Claro",
  dark: "Oscuro",
};

/**
 * Cookie ausente ou com qualquer outro valor → claro, que é o aspecto
 * histórico do CRM. Nunca lança: um cookie adulterado não deve derrubar o
 * layout raiz, do qual pende todo o app.
 */
export function normalizeThemePreference(
  value: string | null | undefined
): ThemePreference {
  return value === "dark" ? "dark" : "light";
}

/** Próximo valor do botão: Claro ⇄ Escuro. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  return current === "dark" ? "light" : "dark";
}
