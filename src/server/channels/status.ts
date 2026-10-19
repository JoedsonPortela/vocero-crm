import { eq, max } from "drizzle-orm";
import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { enabledChannels } from "@/server/channels/enabled";
import { getInstagramCredentialsByOrg } from "@/server/instagram/credentials";
import { getMessengerCredentialsByOrg } from "@/server/messenger/credentials";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { webhookVerifyToken } from "@/server/whatsapp/webhook-url";
import {
  zernioConnectionsOfOrg,
  type ZernioConnection,
} from "@/server/zernio/conexiones";
import {
  accountHealth,
  fetchZernioAccounts,
  zernioAccountName,
  type Health,
  type ZernioAccount,
} from "@/server/zernio/cuentas";
import {
  fetchZernioWebhooks,
  webhookHealth,
  type WebhookHealth,
  type ZernioWebhook,
} from "@/server/zernio/webhooks";

/**
 * 023 — O estado dos canais de uma organização, para Configurações → Canais.
 *
 * Três perguntas por canal: está conectado?, quando entrou a última
 * mensagem? e, se chega pela Zernio, a conta e o webhook continuam bem? As
 * duas primeiras saem do banco; a terceira é perguntada à Zernio naquele
 * momento, com a chave já guardada, e se a Zernio não responder isso é dito
 * em vez de inventar um «tudo bem».
 */

export type ChannelStatus = {
  channel: Channel;
  connected: boolean;
  source: "meta" | "zernio" | null;
  /** A conta, o número ou a página, como uma pessoa a reconhece. */
  account: string | null;
  status: "connected" | "reconnect_required" | null;
  /** ISO-8601 da última mensagem de um cliente por esse canal; null se nenhuma. */
  lastInboundAt: string | null;
  /** Só com fonte Zernio. */
  health: { account: Health; webhook: WebhookHealth } | null;
};

const SIN_ZERNIO: Health = {
  level: "warn",
  message: "No se pudo consultar a Zernio ahora mismo. Vuelve a intentarlo en un momento.",
};

/** Quando entrou a última mensagem de um cliente por cada canal (sem o Laboratório). */
async function lastInboundByChannel(
  organizationId: string
): Promise<Partial<Record<Channel, string>>> {
  const rows = await getDb()
    .select({
      channel: schema.conversation.channel,
      last: max(schema.conversation.lastInboundAt),
    })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false)
      )
    )
    .groupBy(schema.conversation.channel);
  const out: Partial<Record<Channel, string>> = {};
  for (const r of rows) if (r.last) out[r.channel] = r.last.toISOString();
  return out;
}

type Lectura = { accounts: ZernioAccount[]; webhooks: ZernioWebhook[] } | null;

/** O que a Zernio sabe de uma chave; null se não respondeu. */
async function leerZernio(token: string): Promise<Lectura> {
  try {
    const [accounts, webhooks] = await Promise.all([
      fetchZernioAccounts(token),
      fetchZernioWebhooks(token),
    ]);
    return { accounts, webhooks };
  } catch {
    return null;
  }
}

function saludDe(conn: ZernioConnection, lectura: Lectura): ChannelStatus["health"] {
  if (!lectura) {
    return {
      account: SIN_ZERNIO,
      webhook: { ...SIN_ZERNIO, lastFiredAt: null, failureCount: 0 },
    };
  }
  return {
    account: accountHealth(
      lectura.accounts.find((a) => a._id === conn.accountRef) ?? null,
      conn.channel
    ),
    webhook: webhookHealth(lectura.webhooks, webhookVerifyToken(), conn.accountRef),
  };
}

export async function channelsStatus(organizationId: string): Promise<ChannelStatus[]> {
  const encendidos = enabledChannels();
  const [ultimos, wa, ig, fb, zernio] = await Promise.all([
    lastInboundByChannel(organizationId),
    getCredentialsByOrg(organizationId),
    encendidos.has("instagram") ? getInstagramCredentialsByOrg(organizationId) : null,
    encendidos.has("messenger") ? getMessengerCredentialsByOrg(organizationId) : null,
    zernioConnectionsOfOrg(organizationId),
  ]);

  // Uma leitura por chave, não por canal: o normal é que os três compartilhem uma.
  const llaves = [...new Set(zernio.map((c) => c.token))];
  const lecturas = new Map<string, Lectura>(
    await Promise.all(llaves.map(async (t) => [t, await leerZernio(t)] as const))
  );

  const filas: ChannelStatus[] = [];
  for (const channel of CHANNEL_ORDER) {
    if (!encendidos.has(channel)) continue;
    const base = { channel, lastInboundAt: ultimos[channel] ?? null };

    if (channel === "whatsapp") {
      filas.push({
        ...base,
        connected: Boolean(wa),
        source: wa ? "meta" : null,
        account: wa?.displayPhoneNumber ?? null,
        status: wa?.status ?? null,
        health: null,
      });
      continue;
    }

    const conn = zernio.find((c) => c.channel === channel);
    if (conn) {
      const lectura = lecturas.get(conn.token) ?? null;
      // Uma conexão guardada antes da 1.6 pode não ter nome (o Messenger
      // pela Zernio não o pedia): mostra-se o que a Zernio tem agora.
      const enZernio = lectura?.accounts.find((a) => a._id === conn.accountRef);
      filas.push({
        ...base,
        connected: true,
        source: "zernio",
        account: conn.name ?? (enZernio ? zernioAccountName(enZernio) : null),
        status: conn.status,
        health: saludDe(conn, lectura),
      });
      continue;
    }

    // Fonte Meta (app próprio): o estado guardado, que muda quando um envio
    // falha por credenciais.
    const meta =
      channel === "instagram" && ig?.source === "meta"
        ? { account: ig.username ? `@${ig.username}` : ig.igUserId, status: ig.status }
        : channel === "messenger" && fb?.source === "meta"
          ? { account: fb.pageName ?? fb.pageId, status: fb.status }
          : null;
    filas.push({
      ...base,
      connected: Boolean(meta),
      source: meta ? "meta" : null,
      account: meta?.account ?? null,
      status: meta?.status ?? null,
      health: null,
    });
  }
  return filas;
}
