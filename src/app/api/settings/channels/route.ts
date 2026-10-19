import { apiError, withAuth } from "@/lib/api";
import { channelsStatus } from "@/server/channels/status";
import {
  ZERNIO_CHANNELS,
  ensureWebhookForOrg,
} from "@/server/zernio/conexiones";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

/** Sem nenhum canal social ligado, esta superfície não existe (ADR-001). */
const haySociales = () => ZERNIO_CHANNELS.some((c) => isChannelEnabled(c));

/**
 * 023 — Estado dos canais: conexão, última entrada e, com a Zernio, a
 * saúde da conta e do webhook. Nem a chave nem o segredo saem daqui.
 */
export const GET = withAuth(async (session) => {
  if (!haySociales()) return channelDisabledResponse();
  return Response.json({
    channels: await channelsStatus(session.organizationId),
    canManage: session.role === "owner",
  });
});

/**
 * Cadastra ou atualiza o webhook desta instância na Zernio, limitado às
 * contas conectadas. Salvar uma conexão já faz isso; isto serve para
 * tentar de novo se a Zernio falhou e para as instalações anteriores à 1.6.
 */
export const POST = withAuth(async (session) => {
  if (!haySociales()) return channelDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Somente o proprietário pode alterar o webhook");
  }
  const r = await ensureWebhookForOrg(session.organizationId);
  if (!r.ok) {
    const status = r.code === "zernio_unavailable" ? 503 : r.code === "sin_conexiones" ? 409 : 422;
    return apiError(status, r.code, r.message);
  }
  return Response.json(r);
});
