import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  armarEvento,
  clasificarRespuesta,
  firmarCuerpo,
  CABECERA_DISPATCH,
  CABECERA_EVENTO,
  CABECERA_FIRMA,
  CABECERA_ORG,
  type EventoOlvido,
  type EventoDespacho,
  type MensajeParaEvento,
  type ResultadoEntrega,
} from "@/server/brains/contract";
import { leerConfigDespacho } from "@/server/brains/config";
import type { FilaDespacho } from "@/server/dispatch/outbox";
import { isWindowOpen, windowExpiresAt } from "@/server/inbox/window";
import { windowMsFor } from "@/server/channels/capabilities";

/**
 * 021 — Entrega de um despacho ao cérebro: ler a rajada, montar o evento e
 * fazer o POST assinado. Adaptação de `src/server/brains/deliver.ts` do Vocero
 * Cloud sem tipos de cérebro: aqui há um só, o de `BRAIN_DISPATCH_URL`.
 */

/** O que o CRM espera pelo 2xx. Significa «recebido», não «já respondi». */
export const TIMEOUT_ENTREGA_MS = 20_000;

/** Quantas mensagens para trás são olhadas para delimitar a rajada. */
const VENTANA_DE_MENSAJES = 20;

/**
 * As colunas de uma mensagem que o evento precisa, com seu anexo. Função e
 * não constante: o esquema não é tocado ao importar o módulo.
 */
function columnasDelMensaje() {
  return {
    id: schema.message.id,
    direction: schema.message.direction,
    type: schema.message.type,
    text: schema.message.text,
    createdAt: schema.message.createdAt,
    waMediaId: schema.mediaAsset.waMediaId,
    mimeType: schema.mediaAsset.mimeType,
    caption: schema.mediaAsset.caption,
    assetId: schema.mediaAsset.id,
  };
}

function paraEvento(m: {
  id: string;
  createdAt: Date;
  type: string;
  text: string | null;
  waMediaId: string | null;
  mimeType: string | null;
  caption: string | null;
  assetId: string | null;
}): MensajeParaEvento {
  return {
    id: m.id,
    createdAt: m.createdAt,
    type: m.type,
    text: m.text,
    media: m.assetId
      ? { waMediaId: m.waMediaId, mimeType: m.mimeType, caption: m.caption }
      : null,
  };
}

/**
 * A rajada = o que o cliente disse e ainda não foi respondido.
 *
 * Delimita-se pela última mensagem ENVIADA da conversa, não pelas
 * horas do despacho: `first_message_at` é tomado depois de persistir a
 * mensagem, então a primeira da rajada podia ficar uns milissegundos
 * ANTES e cair do evento. Delimitar pela conversa é além disso robusto
 * frente a relógios dessincronizados.
 *
 * 025 — `debidos` são os ids que o despacho tem anotados
 * (`dispatch.message_ids`). O corte pelo último envio confunde «sem
 * responder» com «sem entregar»: o que o cliente escreve enquanto o cérebro
 * pensa fica ATRÁS da resposta à anterior, e essa mensagem ficava
 * sem despacho. Um pendente viaja mesmo que tenha uma resposta do agente depois.
 *
 * O que de fato a quita é uma PESSOA responder (qualquer envio que não
 * seja do agente): essa mensagem já teve quem a atendesse, e mandá-la ao
 * cérebro seria responder duas vezes ao cliente.
 */
export async function rafagaDe(
  organizationId: string,
  conversationId: string,
  debidos: readonly string[] = []
): Promise<MensajeParaEvento[]> {
  const db = getDb();
  const filas = await db
    .select(columnasDelMensaje())
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.mediaAsset.id, schema.message.mediaAssetId)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId)
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(VENTANA_DE_MENSAJES);

  const ordenados = filas.slice().reverse();
  const ultimaSalida = ordenados.reduce(
    (idx, m, i) => (m.direction === "out" ? i : idx),
    -1
  );
  const rafaga = ordenados
    .slice(ultimaSalida + 1)
    .filter((m) => m.direction === "in");

  const enRafaga = new Set(rafaga.map((m) => m.id));
  const faltan = [...new Set(debidos)].filter((id) => !enRafaga.has(id));
  if (!faltan.length) return rafaga.map(paraEvento);

  // A comparação de horas é feita no Postgres, que guarda microssegundos: em
  // JS, duas mensagens do mesmo milissegundo não têm ordem.
  const atrasados = await db
    .select(columnasDelMensaje())
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.mediaAsset.id, schema.message.mediaAssetId)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        and(
          eq(schema.message.conversationId, conversationId),
          eq(schema.message.direction, "in"),
          inArray(schema.message.id, faltan),
          sql`${schema.message.createdAt} > coalesce((
            select max(s.created_at) from message s
            where s.organization_id = ${organizationId}
              and s.conversation_id = ${conversationId}
              and s.direction = 'out'
              and s.ai_generated = false
          ), '-infinity'::timestamp)`
        )
      )
    )
    .orderBy(schema.message.createdAt);
  // Os atrasados são, por definição, anteriores ao último envio; a
  // rajada, posterior. Concatená-los já os deixa em ordem.
  return [...atrasados, ...rafaga].map(paraEvento);
}

/**
 * Pura: a rajada de agora traz algo que o evento entregue não levava?
 *
 * Uma mensagem que entra enquanto seu despacho está em voo não viaja nesse
 * evento (o cérebro já a tem), então ao entregar olha-se de novo: se
 * houver algo novo, enfileira-se outro despacho. Compara-se por id e não por hora, pela
 * mesma razão do lease: microssegundos contra milissegundos.
 */
export function hayMensajesSinDespachar(
  entregados: readonly string[],
  rafagaActual: readonly { id: string }[]
): boolean {
  return sinDespachar(entregados, rafagaActual).length > 0;
}

/** Pura: quais. São os ids que o despacho seguinte traz anotados. */
export function sinDespachar(
  entregados: readonly string[],
  rafagaActual: readonly { id: string }[]
): string[] {
  const vistos = new Set(entregados);
  return rafagaActual.filter((m) => !vistos.has(m.id)).map((m) => m.id);
}

/**
 * Monta o evento normalizado a partir do banco. `null` se a conversa ou o
 * contato já não existirem.
 *
 * 025 — Pode sair com `messages` vazio: uma pessoa respondeu à mão dentro
 * da janela e já não se deve nada. Esse evento não é entregue; quem chama o
 * descarta.
 */
export async function construirEvento(
  fila: FilaDespacho
): Promise<EventoDespacho | null> {
  const db = getDb();
  const [conv] = await db
    .select()
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        fila.organizationId,
        eq(schema.conversation.id, fila.conversationId)
      )
    )
    .limit(1);
  if (!conv) return null;

  const [org] = await db
    .select({ id: schema.organization.id, slug: schema.organization.slug })
    .from(schema.organization)
    .where(eq(schema.organization.id, fila.organizationId))
    .limit(1);
  if (!org) return null;

  const [contact] = await db
    .select()
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        fila.organizationId,
        eq(schema.contact.id, conv.contactId)
      )
    )
    .limit(1);
  if (!contact) return null;

  const messages = await rafagaDe(
    fila.organizationId,
    conv.id,
    fila.messageIds ?? []
  );

  return armarEvento({
    dispatchId: fila.id,
    organization: org,
    conversation: {
      id: conv.id,
      channel: conv.channel,
      aiEnabled: conv.aiEnabled,
      // 022: a janela é a do canal (48 h no TikTok).
      windowOpen: isWindowOpen(
        conv.lastInboundAt,
        new Date(),
        windowMsFor(conv.channel)
      ),
      windowExpiresAt: windowExpiresAt(
        conv.lastInboundAt,
        windowMsFor(conv.channel)
      ),
    },
    contact: {
      id: contact.id,
      displayName: contact.name,
      identity: contact.waIdentity,
    },
    messages,
    firstMessageAt: fila.firstMessageAt,
    lastMessageAt: fila.lastMessageAt,
  });
}

/**
 * O POST assinado.
 *
 * Serializa-se UMA vez e assina-se essa string: assinar um objeto re-serializado
 * produziria uma assinatura que o outro lado não consegue reproduzir. Não se seguem
 * redirecionamentos — um cérebro não redireciona, e segui-los seria mandar o turno para
 * onde outro disser —, e nem o corpo nem a chave chegam a um log.
 */
export async function entregar(
  evento: EventoDespacho,
  destino: { url: string; secret: string },
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<ResultadoEntrega> {
  const cuerpo = JSON.stringify(evento);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? TIMEOUT_ENTREGA_MS
  );
  try {
    const res = await (opts.fetchImpl ?? fetch)(destino.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CABECERA_FIRMA]: firmarCuerpo(cuerpo, destino.secret),
        [CABECERA_DISPATCH]: evento.dispatchId,
        [CABECERA_ORG]: evento.organization.slug ?? evento.organization.id,
      },
      redirect: "manual",
      cache: "no-store",
      body: cuerpo,
      signal: controller.signal,
    });
    await res.body?.cancel().catch(() => {});
    return clasificarRespuesta(res.status);
  } catch {
    // Sem resposta a tempo, nome que não resolve, conexão recusada:
    // tudo é reintentável. O cérebro pode estar reiniciando.
    return {
      ok: false,
      reintentable: true,
      detalle: controller.signal.aborted
        ? `el cerebro no contestó en ${Math.round((opts.timeoutMs ?? TIMEOUT_ENTREGA_MS) / 1000)} s`
        : "no se pudo conectar con el cerebro",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 026 — O que vê quem apagou: se o cérebro confirmou que esqueceu. */
export type ResultadoOlvido = "no_aplica" | "avisado" | "sin_confirmar";

/**
 * Não se faz esperar quem apaga o que um despacho aguarda: quem confirma
 * o recebimento de uma exclusão só precisa guardá-la, não pensar uma resposta.
 */
export const TIMEOUT_OLVIDO_MS = 8000;

/**
 * 026 — Avisa o cérebro de que uma conversa foi apagada.
 *
 * Uma tentativa só, sem fila. A exclusão no CRM já aconteceu e não depende de
 * isto, e o contrato pede ao cérebro tratar um `conversation.id` novo
 * para a mesma pessoa como uma conversa nova — assim um aviso perdido não
 * deixa memória em uso, só guardada até que essa pessoa volte a escrever.
 *
 * Sem despacho configurado não há a quem avisar: o agente incluído não guarda
 * nada à parte, sua memória ERAM as mensagens. Nunca lança.
 */
export async function avisarOlvido(
  evento: EventoOlvido,
  opts: {
    destino?: { url: string; secret: string } | null;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<ResultadoOlvido> {
  const config = leerConfigDespacho();
  const destino =
    opts.destino !== undefined
      ? opts.destino
      : config.active
        ? { url: config.url, secret: config.secret }
        : null;
  if (!destino) return "no_aplica";

  // Serializa-se UMA vez e assina-se essa string, igual a um despacho.
  const cuerpo = JSON.stringify(evento);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_OLVIDO_MS);
  try {
    const res = await (opts.fetchImpl ?? fetch)(destino.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CABECERA_FIRMA]: firmarCuerpo(cuerpo, destino.secret),
        [CABECERA_EVENTO]: evento.type,
        [CABECERA_ORG]: evento.organization.slug ?? evento.organization.id,
      },
      redirect: "manual",
      cache: "no-store",
      body: cuerpo,
      signal: controller.signal,
    });
    await res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 300 ? "avisado" : "sin_confirmar";
  } catch {
    return "sin_confirmar";
  } finally {
    clearTimeout(timer);
  }
}
