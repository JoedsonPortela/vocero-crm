import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { last4, type AiProviderId, type AiStatus } from "@/lib/ai/presets";

/**
 * A credencial do provedor de IA da organização (adaptação de
 * `ai_credentials` do Vocero Cloud, issue #85).
 *
 * Mesmo padrão de `server/whatsapp/credentials.ts`: criptografia AES-256-GCM em
 * repouso e para fora só os últimos 4 caracteres. A resolução «a linha
 * manda, o ambiente é reserva» fica em `lib/ai/provider.ts`; aqui só a
 * linha.
 */

/** O que pode sair para o cliente. NUNCA inclui o token. */
export type AiCredentialPublic = {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  tokenLast4: string;
  status: AiStatus;
  statusReason: string | null;
  statusChangedAt: Date | null;
  updatedAt: Date;
};

/** Para o adaptador: a mesma linha com o token em texto claro. */
export type AiCredentialSecret = AiCredentialPublic & { token: string };

type Row = typeof schema.aiCredentials.$inferSelect;

function toPublic(row: Row): AiCredentialPublic {
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    tokenLast4: row.tokenLast4,
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt,
    updatedAt: row.updatedAt,
  };
}

async function rowDe(organizationId: string): Promise<Row | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.aiCredentials)
    .where(scoped(schema.aiCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAiCredentialPublic(
  organizationId: string
): Promise<AiCredentialPublic | null> {
  const row = await rowDe(organizationId);
  return row ? toPublic(row) : null;
}

/**
 * A linha com o token em texto claro, ESTEJA COMO ESTIVER: quem decide se uma
 * credencial pausada é usada é a resolução, não esta leitura.
 */
export async function getAiCredentialSecret(
  organizationId: string
): Promise<AiCredentialSecret | null> {
  const row = await rowDe(organizationId);
  if (!row) return null;
  return {
    ...toPublic(row),
    token: decryptSecret({
      cipher: row.tokenCipher,
      iv: row.tokenIv,
      tag: row.tokenTag,
    }),
  };
}

export class AiCredentialError extends Error {
  constructor(readonly code: "sin_token") {
    super(
      "No hay una llave guardada: pega la llave del proveedor para configurar la IA"
    );
    this.name = "AiCredentialError";
  }
}

/**
 * Salva (ou substitui) a configuração da organização.
 *
 * Com token: criptografa, salva e o estado VOLTA PARA `active`. Se o dono
 * colou uma chave nova é porque achou que a anterior estava errada; deixá-la
 * pausada faria o agente continuar mudo, sem motivo
 * visível.
 *
 * Sem token: só altera provedor, base URL ou modelo sobre a linha que já
 * existe, com a chave e o estado como estão. Trocar de modelo não conserta uma
 * chave recusada, então não se finge que conserta.
 */
export async function saveAiCredential(input: {
  organizationId: string;
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  token?: string;
}): Promise<AiCredentialPublic> {
  const db = getDb();
  const now = new Date();

  if (input.token === undefined) {
    const updated = await db
      .update(schema.aiCredentials)
      .set({
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        updatedAt: now,
      })
      .where(scoped(schema.aiCredentials.organizationId, input.organizationId))
      .returning();
    const row = updated[0];
    if (!row) throw new AiCredentialError("sin_token");
    return toPublic(row);
  }

  const enc = encryptSecret(input.token);
  const valores = {
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    tokenCipher: enc.cipher,
    tokenIv: enc.iv,
    tokenTag: enc.tag,
    tokenLast4: last4(input.token),
    status: "active" as const,
    statusReason: null,
    statusChangedAt: now,
    updatedAt: now,
  };
  const rows = await db
    .insert(schema.aiCredentials)
    .values({
      id: newId("aiCredentials"),
      organizationId: input.organizationId,
      ...valores,
    })
    .onConflictDoUpdate({
      target: [schema.aiCredentials.organizationId],
      set: valores,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("no se pudo leer la credencial recién guardada");
  return toPublic(row);
}

export async function deleteAiCredential(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.aiCredentials)
    .where(scoped(schema.aiCredentials.organizationId, organizationId));
}

/**
 * O que fazer com o estado conforme a resposta do provedor.
 *
 * Função PURA para poder testar a tabela de decisão sem banco de dados: é
 * uma dessas regras que parecem óbvias e são implementadas errado.
 *
 * - **401** → a chave não funciona. Pausa.
 * - **402** → sem saldo. Pausa, com outro motivo: ao dono interessa saber se
 *   precisa trocar a chave ou recarregar a conta.
 * - **429** → limite de TAXA, não falta de crédito. **Não pausa**: confundi-los
 *   desligaria o agente por um pico de tráfego, justo quando mais é preciso.
 * - Qualquer outro erro (500 do provedor, timeout, rede) → também não pausa.
 *   Um soluço do provedor não é um problema da credencial.
 */
export function estadoSegunRespuesta(httpStatus: number): AiStatus | null {
  if (httpStatus === 401) return "paused_invalid_token";
  if (httpStatus === 402) return "paused_no_credit";
  return null;
}

/** Aplica a pausa que o provedor determinar. Retorna true se pausou. */
export async function marcarEstadoPorRespuesta(
  organizationId: string,
  httpStatus: number,
  detalle?: string
): Promise<boolean> {
  const nuevo = estadoSegunRespuesta(httpStatus);
  if (!nuevo) return false;
  const db = getDb();
  await db
    .update(schema.aiCredentials)
    .set({
      status: nuevo,
      statusReason: detalle?.slice(0, 200) ?? null,
      statusChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(scoped(schema.aiCredentials.organizationId, organizationId));
  return true;
}

/**
 * O provedor aceitou a chave salva (botão «Testar conexão»): se estava
 * pausada, volta para `active`. É o caminho de «recarreguei o saldo e quero que
 * volte a responder» sem precisar colar a mesma chave de novo.
 */
export async function marcarActiva(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.aiCredentials)
    .set({
      status: "active",
      statusReason: null,
      statusChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(scoped(schema.aiCredentials.organizationId, organizationId));
}
