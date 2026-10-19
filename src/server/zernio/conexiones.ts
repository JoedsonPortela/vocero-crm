import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { MetaApiError } from "@/lib/meta/client";
import { CHANNEL_ORDER } from "@/lib/channels";
import { isChannelEnabled } from "@/server/channels/enabled";
import {
  getInstagramCredentialsByAccountRef,
  getInstagramCredentialsByOrg,
} from "@/server/instagram/credentials";
import {
  getMessengerCredentialsByAccountRef,
  getMessengerCredentialsByOrg,
} from "@/server/messenger/credentials";
import {
  getTiktokCredentialsByAccountRef,
  getTiktokCredentialsByOrg,
} from "@/server/tiktok/credentials";
import {
  webhookUrl,
  webhookVerifyToken,
  type WebhookChannel,
} from "@/server/whatsapp/webhook-url";
import { fetchZernioAccounts, type ZernioChannel } from "@/server/zernio/cuentas";
import { columnasDelSecreto } from "@/server/zernio/secreto-guardado";
import {
  cachedZernioWebhooks,
  ensureZernioWebhook,
  pointsHere,
} from "@/server/zernio/webhooks";

/**
 * 023 — As conexões pela Zernio de uma organização, numa só forma.
 *
 * Cada canal guarda suas credenciais na sua tabela (014, 017, 022), mas para
 * a Zernio os três são a mesma coisa: uma conta, uma chave e um segredo de assinatura.
 * O que é UM na Zernio —o webhook e seu segredo— se resolve aqui, uma vez,
 * em vez de três vezes quase iguais.
 */

export const ZERNIO_CHANNELS = CHANNEL_ORDER.filter(
  (c): c is ZernioChannel => c !== "whatsapp"
);

/** Segmento da rota do webhook de cada canal. */
const WEBHOOK_PATH: Record<ZernioChannel, WebhookChannel> = {
  instagram: "ig",
  messenger: "messenger",
  tiktok: "tiktok",
};

export type ZernioConnection = {
  channel: ZernioChannel;
  /** Id da linha de credenciais. */
  id: string;
  organizationId: string;
  accountRef: string;
  token: string;
  webhookSecret: string | null;
  /** Nome pelo qual uma pessoa reconhece a conta. */
  name: string | null;
  status: "connected" | "reconnect_required";
};

const arroba = (u: string | null) => (u ? `@${u.replace(/^@/, "")}` : null);

async function byOrg(
  channel: ZernioChannel,
  organizationId: string
): Promise<ZernioConnection | null> {
  if (channel === "instagram") {
    const c = await getInstagramCredentialsByOrg(organizationId);
    if (!c || c.source !== "zernio" || !c.accountRef) return null;
    return { channel, ...comun(c), accountRef: c.accountRef, name: arroba(c.username) };
  }
  if (channel === "messenger") {
    const c = await getMessengerCredentialsByOrg(organizationId);
    if (!c || c.source !== "zernio" || !c.accountRef) return null;
    return { channel, ...comun(c), accountRef: c.accountRef, name: c.pageName };
  }
  const c = await getTiktokCredentialsByOrg(organizationId);
  if (!c) return null;
  return { channel, ...comun(c), accountRef: c.accountRef, name: arroba(c.username) };
}

async function byAccountRef(
  channel: ZernioChannel,
  accountRef: string
): Promise<ZernioConnection | null> {
  if (channel === "instagram") {
    const c = await getInstagramCredentialsByAccountRef(accountRef);
    if (!c || c.source !== "zernio" || !c.accountRef) return null;
    return { channel, ...comun(c), accountRef: c.accountRef, name: arroba(c.username) };
  }
  if (channel === "messenger") {
    const c = await getMessengerCredentialsByAccountRef(accountRef);
    if (!c || c.source !== "zernio" || !c.accountRef) return null;
    return { channel, ...comun(c), accountRef: c.accountRef, name: c.pageName };
  }
  const c = await getTiktokCredentialsByAccountRef(accountRef);
  if (!c) return null;
  return { channel, ...comun(c), accountRef: c.accountRef, name: arroba(c.username) };
}

function comun(c: {
  id: string;
  organizationId: string;
  token: string;
  webhookSecret: string | null;
  status: "connected" | "reconnect_required";
}) {
  return {
    id: c.id,
    organizationId: c.organizationId,
    token: c.token,
    webhookSecret: c.webhookSecret,
    status: c.status,
  };
}

/** As conexões pela Zernio dos canais LIGADOS dessa organização. */
export async function zernioConnectionsOfOrg(
  organizationId: string
): Promise<ZernioConnection[]> {
  const found = await Promise.all(
    ZERNIO_CHANNELS.filter((c) => isChannelEnabled(c)).map((c) => byOrg(c, organizationId))
  );
  return found.filter((c): c is ZernioConnection => c !== null);
}

type EventAccount = { id?: string; accountId?: string; profileId?: string };

/**
 * A conexão para a qual vai um evento da Zernio. SOMENTE LEITURA: é chamada antes de
 * verificar a assinatura, então não pode mudar nada. `viaProfile` diz que a
 * linha guardou o id do perfil em vez do da conta.
 */
export async function findZernioConnection(
  channel: ZernioChannel,
  account: EventAccount | undefined
): Promise<{ connection: ZernioConnection; viaProfile: boolean } | null> {
  const id = account?.id ?? account?.accountId;
  if (!id) return null;
  const directa = await byAccountRef(channel, id);
  if (directa) return { connection: directa, viaProfile: false };
  if (!account?.profileId) return null;
  const porPerfil = await byAccountRef(channel, account.profileId);
  return porPerfil ? { connection: porPerfil, viaProfile: true } : null;
}

/** 030 — O segredo é gravado criptografado (`columnasDelSecreto`), nunca em texto claro. */
async function update(
  channel: ZernioChannel,
  id: string,
  set: { accountRef?: string; webhookSecret?: string }
): Promise<void> {
  const { webhookSecret, ...resto } = set;
  const values = {
    ...resto,
    ...(webhookSecret !== undefined ? columnasDelSecreto(webhookSecret) : {}),
    updatedAt: new Date(),
  };
  const db = getDb();
  if (channel === "instagram") {
    await db
      .update(schema.instagramCredentials)
      .set(values)
      .where(eq(schema.instagramCredentials.id, id));
  } else if (channel === "messenger") {
    await db
      .update(schema.messengerCredentials)
      .set(values)
      .where(eq(schema.messengerCredentials.id, id));
  } else {
    await db
      .update(schema.tiktokCredentials)
      .set(values)
      .where(eq(schema.tiktokCredentials.id, id));
  }
}

/**
 * Corrige uma linha que guardou o id do perfil. É chamada DEPOIS de verificar
 * a assinatura: é uma mudança de estado, e uma que altera por onde saem as
 * mensagens (o envio usa o mesmo campo).
 */
export async function healZernioAccountRef(
  channel: ZernioChannel,
  account: EventAccount | undefined
): Promise<void> {
  const found = await findZernioConnection(channel, account);
  const id = account?.id ?? account?.accountId;
  if (!found?.viaProfile || !id) return;
  await update(channel, found.connection.id, { accountRef: id });
  console.warn(
    `[zernio] la conexión de ${channel} tenía el id del perfil (${account?.profileId}): corregida a la cuenta ${id}`
  );
}

/** Os segredos de assinatura guardados nos canais pela Zernio dessa organização. */
export async function storedZernioSecrets(organizationId: string): Promise<string[]> {
  const conns = await zernioConnectionsOfOrg(organizationId);
  return [...new Set(conns.map((c) => c.webhookSecret).filter((s): s is string => !!s))];
}

/**
 * Puro: quais contas leva o webhook de UMA chave.
 *
 * Não são «as conexões guardadas com essa chave», mas todas as conexões
 * da organização cuja conta essa chave enxerga. A diferença importa quando
 * dois canais ficaram guardados com chaves diferentes da MESMA conta da
 * Zernio (rotacionou-se a chave e só se reconectou um canal): as duas chaves veem
 * o mesmo webhook, e se cada uma o deixasse só com «as suas» contas, a segunda
 * tiraria as da primeira e aquele canal deixaria de receber em silêncio.
 *
 * Se a chave não enxerga nenhuma (uma lista de contas que ainda não reflete a
 * conexão), mandam-se as do grupo e que a Zernio decida.
 */
export function webhookAccountIds(
  all: readonly { accountRef: string }[],
  group: readonly { accountRef: string }[],
  visible: ReadonlySet<string>
): string[] {
  const vistas = all.map((c) => c.accountRef).filter((id) => visible.has(id));
  return [...new Set(vistas.length > 0 ? vistas : group.map((c) => c.accountRef))];
}

export type EnsureWebhookResult =
  | { ok: true; created: boolean; accounts: number }
  | { ok: false; code: string; message: string };

/**
 * Cadastra (ou atualiza) na Zernio o webhook desta instância para as
 * contas conectadas a essa organização, e deixa o mesmo segredo em todos os seus
 * canais. Nunca lança: salvar uma conexão não pode falhar porque a Zernio
 * teve um soluço ao registrar o webhook.
 *
 * Uma instância é um negócio (constituição): o limite de contas do webhook
 * é o de ESTA organização.
 *
 * `secret` é o que alguém acabou de informar de propósito ao salvar uma conexão:
 * prevalece sobre os que já houvesse, e fica em todos os canais e na Zernio.
 */
export async function ensureWebhookForOrg(
  organizationId: string,
  opts: { secret?: string | null } = {}
): Promise<EnsureWebhookResult> {
  const conns = await zernioConnectionsOfOrg(organizationId);
  if (conns.length === 0) {
    return {
      ok: false,
      code: "sin_conexiones",
      message: "Não há nenhum canal conectado pelo Zernio.",
    };
  }

  const env = getEnv();
  // A Zernio precisa alcançar a URL de fora. `ZERNIO_BASE_URL` só é
  // definido em testes (o simulador), e aí a URL local vale.
  const url = webhookUrl(WEBHOOK_PATH[conns[0]!.channel]);
  if (!url.startsWith("https://") && !process.env.ZERNIO_BASE_URL) {
    return {
      ok: false,
      code: "sin_https",
      message:
        "Esta instancia no tiene una URL pública con https (APP_BASE_URL): Zernio no puede entregarle mensajes.",
    };
  }

  const segment = webhookVerifyToken();
  const name = `vocero-${new URL(env.APP_BASE_URL).host}`;
  const acceptableUrls = ZERNIO_CHANNELS.filter((c) => isChannelEnabled(c)).map((c) =>
    webhookUrl(WEBHOOK_PATH[c])
  );

  try {
    // Um segredo para todos: o que acabou de ser informado; senão, o que já esteja
    // guardado; senão, o do webhook que já aponta para cá; senão, um novo.
    let secret =
      opts.secret ||
      (conns.map((c) => c.webhookSecret).find((s): s is string => !!s) ?? null);
    if (!secret) {
      const { webhooks } = await cachedZernioWebhooks(conns[0]!.token);
      secret =
        webhooks.find((w) => pointsHere(w, segment) && w.secret)?.secret ??
        randomBytes(24).toString("hex");
    }

    // O normal é uma só chave; se cada canal usa uma conta da Zernio
    // diferente, cada chave leva seu webhook com suas contas.
    const porLlave = new Map<string, ZernioConnection[]>();
    for (const c of conns) porLlave.set(c.token, [...(porLlave.get(c.token) ?? []), c]);

    let created = false;
    const cubiertas = new Set<string>();
    for (const [token, grupo] of porLlave) {
      const visibles = new Set((await fetchZernioAccounts(token)).map((a) => a._id));
      const accountIds = webhookAccountIds(conns, grupo, visibles);
      const r = await ensureZernioWebhook({
        token,
        segment,
        name,
        url,
        acceptableUrls,
        accountIds,
        secret,
      });
      created ||= r.created;
      for (const id of accountIds) cubiertas.add(id);
    }

    for (const c of conns) {
      if (c.webhookSecret !== secret) await update(c.channel, c.id, { webhookSecret: secret });
    }
    return { ok: true, created, accounts: cubiertas.size };
  } catch (err) {
    const caido = err instanceof MetaApiError && (err.status === 0 || err.status >= 500);
    console.warn("[zernio] no se pudo dar de alta el webhook:", err instanceof Error ? err.message : err);
    return caido
      ? {
          ok: false,
          code: "zernio_unavailable",
          message: "Não foi possível contatar o Zernio para cadastrar o webhook. Tente de novo em Canais → Estado.",
        }
      : {
          ok: false,
          code: "zernio_rejected",
          message: "Zernio no aceptó el webhook. Reinténtalo desde Canales → Estado o créalo a mano en Zernio.",
        };
  }
}
