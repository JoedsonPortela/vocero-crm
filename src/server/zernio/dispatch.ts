import { isChannelEnabled } from "@/server/channels/enabled";
import { processZernioEvent } from "@/server/instagram/ingest";
import { processZernioMessengerEvent } from "@/server/messenger/ingest";
import { processZernioTiktokEvent, zernioPlatform } from "@/server/tiktok/ingest";
import { webhookVerifyToken } from "@/server/whatsapp/webhook-url";
import {
  isValidZernioSignatureAny,
  parseZernioEvent,
  type ZernioEvent,
} from "@/server/zernio";
import {
  findZernioConnection,
  healZernioAccountRef,
  storedZernioSecrets,
} from "@/server/zernio/conexiones";
import type { ZernioChannel } from "@/server/zernio/cuentas";
import {
  WEBHOOKS_RECHECK_MS,
  webhookSecretsFromZernio,
} from "@/server/zernio/webhooks";

/**
 * 017 — Repasse de um evento da Zernio ao canal que lhe cabe.
 *
 * A Zernio entrega TODAS as plataformas conectadas a essa chave por UM só
 * webhook: o que se cadastre recebe as DMs do Instagram e as mensagens da
 * página do Facebook igualmente. Se cada canal só atendesse a sua própria URL,
 * quem tiver o webhook apontado para `/api/webhooks/ig/...` veria suas mensagens
 * do Messenger descartadas em silêncio — o pior modo de falha possível, porque
 * o webhook responde 200 e não há nada para investigar.
 *
 * Então todas as rotas da Zernio repartem por `account.platform`, e tanto faz
 * qual das URLs esteja configurada. 022: o TikTok entra no mesmo repasse.
 */

/** A qual canal pertence um evento, ou null se não for de nenhum nosso. */
export function zernioTargetChannel(payload: unknown): ZernioChannel | null {
  const evt = payload as ZernioEvent | null;
  if (!evt || typeof evt !== "object") return null;
  const platform = zernioPlatform(evt);
  if (platform === "instagram") return "instagram";
  if (platform === "facebook" || platform === "messenger") return "messenger";
  if (platform === "tiktok") return "tiktok";
  return null;
}

/**
 * 023 — Esta entrega foi assinada pela Zernio para esta instância?
 *
 * O segredo é do WEBHOOK, não do canal: um webhook da Zernio atende a todas
 * as contas da sua chave e assina com um só. Por isso vale qualquer um dos
 * segredos guardados nos canais pela Zernio da organização, e se
 * nenhum coincidir (ou não houver), os dos webhooks da Zernio que apontam para cá,
 * lidos com a chave já guardada. Assim um segredo mal capturado deixa de derrubar
 * um canal, e um que nunca foi capturado é exigido igual. Essa leitura é guardada
 * por alguns minutos; se a assinatura não coincidir com o guardado, relê-se, no máximo
 * uma vez por minuto, caso o segredo tenha mudado na Zernio.
 *
 * Resolve-se ANTES de processar e sem escrever nada. Um evento sem conta, ou
 * de uma conta que ninguém conectou aqui, não tem contra o que se comparar e passa:
 * `processZernioPayload` o descarta sem ingerir nada. Sem nenhum segredo em
 * lugar nenhum a camada fica desligada, como sempre, e protege o segmento
 * secreto da URL.
 */
export async function isAuthenticZernioDelivery(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  const evt = parseZernioEvent(rawBody);
  const channel = zernioTargetChannel(evt);
  if (!evt || !channel) return true;
  const found = await findZernioConnection(channel, evt.account);
  if (!found) return true;

  const stored = await storedZernioSecrets(found.connection.organizationId);
  if (stored.length > 0 && isValidZernioSignatureAny(rawBody, signature, stored)) {
    return true;
  }
  const { token } = found.connection;
  const segment = webhookVerifyToken();
  const remote = await webhookSecretsFromZernio(token, segment);
  if (remote.length > 0 && isValidZernioSignatureAny(rawBody, signature, remote)) {
    return true;
  }
  const fresh = await webhookSecretsFromZernio(token, segment, WEBHOOKS_RECHECK_MS);
  if (stored.length === 0 && fresh.length === 0) return true;
  return fresh.length > 0 && isValidZernioSignatureAny(rawBody, signature, fresh);
}

/**
 * Processa o evento pelo canal ao qual pertence. Um canal desligado descarta
 * com aviso: a instância não o tem, e sua superfície não existe (ADR-001).
 */
export async function processZernioPayload(payload: unknown): Promise<void> {
  const channel = zernioTargetChannel(payload);
  if (!channel) return; // outra plataforma conectada à mesma chave: não é nossa

  if (!isChannelEnabled(channel)) {
    console.warn(
      `[zernio] evento de ${channel} con el canal apagado en esta instancia: descartado`
    );
    return;
  }

  // 023: uma conexão guardada com o id do perfil é corrigida aqui, já com
  // a assinatura verificada, e o canal a encontra pelo id da conta.
  await healZernioAccountRef(channel, (payload as ZernioEvent).account);

  if (channel === "messenger") await processZernioMessengerEvent(payload);
  else if (channel === "tiktok") await processZernioTiktokEvent(payload);
  else await processZernioEvent(payload);
}
