/**
 * 021 — Há um cérebro para o qual despachar? Duas coisas, e as duas pelo ambiente:
 * `BRAIN_DISPATCH_URL` (para onde) e `BOT_API_KEY` (com que se assina, e com que
 * responde o cérebro por `/api/bot/*`).
 *
 * Ativo, o despacho silencia o agente incluído: os dois caminhos são
 * excludentes (`server/ai/trigger.ts`). Mal configurado NÃO está ativo: tudo
 * se comporta como se a variável não existisse, e o cartão «Quem responde»
 * diz o que corrigir. Preferível a deixar a instância muda por uma URL mal
 * escrita.
 *
 * Diferente da edição cloud, aqui não se exige uma URL pública: quem a põe é
 * quem instala, não um terceiro, e o normal é o endereço interno do
 * contêiner do cérebro (`http://nea:8000/vocero/dispatch`).
 */

const MIN_KEY_LENGTH = 16;

export type ProblemaDespacho =
  /** `BRAIN_DISPATCH_URL` não é uma URL http(s), ou traz usuário e senha. */
  | "url"
  /** Falta `BOT_API_KEY` (ou tem menos de 16 caracteres): não há com que assinar. */
  | "sin_llave";

export type ConfigDespacho =
  | { active: true; url: string; host: string; secret: string }
  | { active: false; host: string | null; problem: ProblemaDespacho | null };

type Entorno = Record<string, string | undefined>;

/** Pura sobre o ambiente que recebe: usam-na o worker, o cartão e `pnpm doctor`. */
export function leerConfigDespacho(env: Entorno = process.env): ConfigDespacho {
  const raw = env.BRAIN_DISPATCH_URL?.trim();
  if (!raw) return { active: false, host: null, problem: null };

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { active: false, host: null, problem: "url" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { active: false, host: null, problem: "url" };
  }
  // Sem credenciais na URL: o despacho já vai assinado, e o `fetch` rejeita
  // uma URL que as traz. Melhor dizer isso do que falhar a cada turno.
  if (target.username || target.password) {
    return { active: false, host: target.host, problem: "url" };
  }

  const secret = env.BOT_API_KEY;
  if (typeof secret !== "string" || secret.length < MIN_KEY_LENGTH) {
    return { active: false, host: target.host, problem: "sin_llave" };
  }
  return { active: true, url: target.toString(), host: target.host, secret };
}

/** O CRM está empurrando turnos para um cérebro. */
export function despachoActivo(): boolean {
  return leerConfigDespacho().active;
}
