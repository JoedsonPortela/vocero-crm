import { z } from "zod";
import {
  AI_PROVIDERS,
  AI_PROVIDER_PRESETS,
  last4,
  type AiProviderId,
} from "@/lib/ai/presets";
import {
  envAiProvider,
  estadoIaDe,
  mensajeDeEstado,
  type EstadoIa,
} from "@/lib/ai/provider";
import {
  getAiCredentialPublic,
  getAiCredentialSecret,
  type AiCredentialPublic,
} from "@/server/ai/credentials";

/**
 * Configurações → IA: o que valida e o que retorna `/api/settings/ai`. Fora do
 * `route.ts` para poder testá-lo sem sessão.
 */

const baseUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "La base URL debe empezar por http:// o https://",
  });

/**
 * O mínimo da chave é flexível de propósito: o formato é decidido pelo provedor
 * e muda sem aviso. Quem decide se ela funciona é o provedor, ao usá-la
 * («Testar conexão»).
 */
const tokenSchema = z.string().trim().min(8).max(4096);

const modelSchema = z.string().trim().min(1).max(200);

const conProveedor = {
  // Sem `.default()`: com ele, `parseBody` infere o tipo de ENTRADA (com
  // `undefined`) e o handler perde a tipagem. A UI sempre o envia.
  provider: z.enum(AI_PROVIDERS),
  /** Obrigatória com «Outro compatível com OpenAI»; com OpenRouter é ignorada. */
  baseUrl: baseUrlSchema.optional(),
};

function exigeBaseUrl(
  data: { provider: AiProviderId; baseUrl?: string },
  ctx: z.RefinementCtx
) {
  if (data.provider === "openai_compatible" && !data.baseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "Con «Outro compatível com OpenAI» hay que indicar la base URL",
    });
  }
}

/** `PUT /api/settings/ai`: sem `token` altera só provedor/modelo. */
export const aiSettingsPutSchema = z
  .object({
    ...conProveedor,
    model: modelSchema,
    token: tokenSchema.optional(),
  })
  .superRefine(exigeBaseUrl);

/** `POST /api/settings/ai/test`: sem `token` testa a chave salva. */
export const aiProbeSchema = z
  .object({
    ...conProveedor,
    model: modelSchema,
    token: tokenSchema.optional(),
  })
  .superRefine(exigeBaseUrl);

/** `POST /api/settings/ai/models`: sem `token` usa a chave salva. */
export const aiModelsSchema = z
  .object({
    ...conProveedor,
    token: tokenSchema.optional(),
  })
  .superRefine(exigeBaseUrl);

/** A base URL que de fato é usada: a do preset, ou a digitada. */
export function baseUrlEfectiva(
  provider: AiProviderId,
  baseUrl: string | undefined
): string {
  const preset = AI_PROVIDER_PRESETS[provider].baseUrl;
  if (preset) return preset;
  // O esquema já exigiu a base URL para este preset; o fallback só
  // tranquiliza a tipagem.
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

/**
 * A chave com que testar ou listar: a digitada, ou a salva. `null` se
 * não houver nenhuma das duas.
 */
export async function llaveParaProbar(
  organizationId: string,
  escrita: string | undefined
): Promise<{ token: string; guardada: boolean } | null> {
  if (escrita) return { token: escrita, guardada: false };
  const cred = await getAiCredentialSecret(organizationId);
  return cred ? { token: cred.token, guardada: true } : null;
}

export type AiSettingsView = {
  credencial: {
    proveedor: AiProviderId;
    baseUrl: string;
    modelo: string;
    tokenLast4: string;
    estado: AiCredentialPublic["status"];
    motivo: string | null;
    desde: string | null;
    actualizado: string;
  } | null;
  /** O que o adaptador resolve agora mesmo (linha e, se não houver, ambiente). */
  activa: boolean;
  origen: "org" | "env" | null;
  mensaje: string | null;
  /** As variáveis `OPENROUTER_*`, se existirem: o fallback. */
  respaldoEntorno: { baseUrl: string; modelo: string; tokenLast4: string } | null;
};

export function credencialVista(
  cred: AiCredentialPublic | null
): AiSettingsView["credencial"] {
  if (!cred) return null;
  return {
    proveedor: cred.provider,
    baseUrl: cred.baseUrl,
    modelo: cred.model,
    tokenLast4: cred.tokenLast4,
    estado: cred.status,
    motivo: cred.statusReason,
    desde: cred.statusChangedAt?.toISOString() ?? null,
    actualizado: cred.updatedAt.toISOString(),
  };
}

export async function vistaAjustesIa(
  organizationId: string
): Promise<AiSettingsView> {
  const [cred, estado] = await Promise.all([
    getAiCredentialPublic(organizationId),
    estadoIaDe(organizationId),
  ]);
  return armarVista(cred, estado);
}

/** Pura, para os testes. */
export function armarVista(
  cred: AiCredentialPublic | null,
  estado: EstadoIa
): AiSettingsView {
  const env = envAiProvider();
  return {
    credencial: credencialVista(cred),
    activa: estado.activa,
    origen: estado.activa ? estado.origen : null,
    mensaje: mensajeDeEstado(estado),
    respaldoEntorno: env
      ? { baseUrl: env.baseUrl, modelo: env.model, tokenLast4: last4(env.token) }
      : null,
  };
}
