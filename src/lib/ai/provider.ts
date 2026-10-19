import { isAiConfiguredByEnv } from "@/lib/env";
import { last4, OPENROUTER_BASE_URL } from "@/lib/ai/presets";
import {
  getAiCredentialPublic,
  getAiCredentialSecret,
  type AiCredentialPublic,
  type AiCredentialSecret,
} from "@/server/ai/credentials";

/**
 * Com qual provedor de IA esta organização fala (issue #85).
 *
 * Precedência: o que foi salvo em Ajustes → IA prevalece; as variáveis
 * `OPENROUTER_*` do ambiente ficam como reserva para instalações
 * automatizadas (ou para quem já as tinha). Uma linha PAUSADA não cai no
 * ambiente: o dono configurou a sua chave, e que o agente seguisse falando com
 * outra sem avisar seria esconder-lhe o problema que precisa resolver.
 *
 * As funções puras (`interpretarCredencial`, `resolver`) existem para
 * testar a tabela de decisão sem banco de dados.
 */

export type AiProvider = {
  source: "org" | "env";
  baseUrl: string;
  model: string;
  judgeModel: string;
  token: string;
};

export type EstadoIa =
  | { activa: true; origen: "org" | "env"; last4: string }
  | { activa: false; motivo: "sin_configurar" }
  | {
      activa: false;
      motivo: "token_invalido" | "sin_saldo";
      last4: string;
      desde: Date | null;
    };

export type AiResolution =
  | { ok: true; provider: AiProvider }
  | { ok: false; estado: Exclude<EstadoIa, { activa: true }> };

/**
 * A reserva do ambiente, ou `null` sem `OPENROUTER_API_TOKEN`. O modelo
 * pode vir vazio: isso é reportado pelo `chatJson` como `not_configured` com o seu
 * detalhe, igual a antes.
 *
 * É lido de `process.env` direto, não por `getEnv()`, igual a
 * `isMockEnabled()` e as flags: perguntar se há IA não pode depender de
 * que TODO o ambiente valide. Com `getEnv()`, um turno do agente estourava
 * —em vez de degradar— só por consultar isto (ver `server/agenda/flag.ts`).
 * Strings vazias contam como ausentes, como em `getEnv()`.
 */
export function envAiProvider(): AiProvider | null {
  if (!isAiConfiguredByEnv()) return null;
  const model = leer("OPENROUTER_MODEL") ?? "";
  return {
    source: "env",
    baseUrl: leer("OPENROUTER_BASE_URL") ?? OPENROUTER_BASE_URL,
    model,
    judgeModel: leer("OPENROUTER_JUDGE_MODEL") ?? model,
    token: leer("OPENROUTER_API_TOKEN") ?? "",
  };
}

function leer(nombre: string): string | undefined {
  const v = process.env[nombre];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

type CredEstado = Pick<
  AiCredentialPublic,
  "status" | "tokenLast4" | "statusChangedAt"
>;

/** Pura: a linha manda; sem linha, o ambiente; sem nada, não configurado. */
export function interpretarCredencial(
  cred: CredEstado | null,
  env: { last4: string } | null
): EstadoIa {
  if (cred) {
    if (cred.status === "active") {
      return { activa: true, origen: "org", last4: cred.tokenLast4 };
    }
    return {
      activa: false,
      motivo:
        cred.status === "paused_invalid_token" ? "token_invalido" : "sin_saldo",
      last4: cred.tokenLast4,
      desde: cred.statusChangedAt,
    };
  }
  if (env) return { activa: true, origen: "env", last4: env.last4 };
  return { activa: false, motivo: "sin_configurar" };
}

/** Pura: a resolução completa, com o token, para o adaptador. */
export function resolver(
  cred: AiCredentialSecret | null,
  env: AiProvider | null
): AiResolution {
  const estado = interpretarCredencial(
    cred,
    env ? { last4: last4(env.token) } : null
  );
  if (!estado.activa) return { ok: false, estado };
  if (estado.origen === "org" && cred) {
    return {
      ok: true,
      provider: {
        source: "org",
        baseUrl: cred.baseUrl,
        model: cred.model,
        // Um só modelo na UI: o juiz do Laboratório usa o mesmo.
        judgeModel: cred.model,
        token: cred.token,
      },
    };
  }
  if (env) return { ok: true, provider: env };
  return { ok: false, estado: { activa: false, motivo: "sin_configurar" } };
}

/**
 * Sem organização (uma chamada avulsa) só conta o ambiente: não há linha
 * para consultar.
 */
export async function resolveAiProvider(
  organizationId?: string
): Promise<AiResolution> {
  const cred = organizationId
    ? await getAiCredentialSecret(organizationId)
    : null;
  return resolver(cred, envAiProvider());
}

export async function estadoIaDe(organizationId: string): Promise<EstadoIa> {
  const cred = await getAiCredentialPublic(organizationId);
  const env = envAiProvider();
  return interpretarCredencial(cred, env ? { last4: last4(env.token) } : null);
}

/** Atalho para os lugares que só precisam do sim/não. */
export async function isAiConfiguredFor(
  organizationId: string
): Promise<boolean> {
  return (await estadoIaDe(organizationId)).activa;
}

/** A mensagem que o dono vê quando seu agente não consegue responder. */
export function mensajeDeEstado(estado: EstadoIa): string | null {
  if (estado.activa) return null;
  switch (estado.motivo) {
    case "sin_configurar":
      // «Desligado» não: o interruptor da tela Agente pode dizer
      // «Ligado». O problema não é estar desligado, é não ter com
      // o que pensar.
      return "Tu agente no puede contestar todavía: configura tu proveedor de IA en Ajustes → IA.";
    case "token_invalido":
      return "Tu agente está pausado: el proveedor rechazó tu llave. Revísala en Ajustes → IA.";
    case "sin_saldo":
      return "Tu agente está pausado: tu cuenta del proveedor de IA se quedó sin saldo. Recárgala y pulsa «Probar conexión» en Ajustes → IA.";
  }
}
