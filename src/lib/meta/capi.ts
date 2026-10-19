import { graphRequest } from "@/lib/meta/client";

/**
 * 016 — Conversions API da Meta, variante `business_messaging`.
 *
 * Fronteira de saída única: o mesmo `graphRequest` com o qual o CRM envia
 * mensagens. Não há um segundo caminho para a internet, nem um cliente novo, nem uma
 * dependência nova: é a mesma Graph API do canal que a instância já usa.
 *
 * O que isso faz pelo negócio: a Meta sabe quais conversas COMEÇARAM a partir de um
 * anúncio, mas não sabe quais serviram. Sem alguém que lhe diga, ela otimiza
 * para o único que vê — que alguém abra o chat — e entrega o público mais
 * barato de fazer escrever, que não é o que compra.
 */

/** Como se identifica o software que integrou o evento. Constante do projeto. */
const PARTNER_AGENT = "vocero-crm";

export type BusinessMessagingEvent = {
  eventName: string;
  /** Epoch em SEGUNDOS do momento da conversão. */
  eventTime: number;
  ctwaClid: string;
  wabaId: string;
  /**
   * `custom_data` do evento. Importa mais do que parece: é o ÚNICO contra
   * o qual uma **conversão personalizada** da Meta pode escrever regras. Nem
   * `event_name` nem `action_source` são parâmetros configuráveis, e estes eventos
   * não levam `event_source_url`, então um evento sem `custom_data` não pode
   * cumprir NENHUMA regra — e uma conversão personalizada sem regras
   * cumpríveis fica em zero para sempre, sem dizer por quê.
   */
  customData?: Record<string, unknown>;
};

/**
 * Catálogo FECHADO de `event_name` que a Meta aceita com
 * `action_source: "business_messaging"`. Qualquer outro nome é um 400 opaco.
 *
 * O Vocero só emite dois deles (`QualifiedLead` e `Purchase`); a lista
 * completa fica aqui para que um fork que adicione o seu não descubra o
 * catálogo na marra.
 *
 * Doc: /docs/marketing-api/conversions-api/business-messaging
 */
export const META_BUSINESS_MESSAGING_EVENTS = [
  "Purchase",
  "LeadSubmitted",
  "QualifiedLead",
  "InitiateCheckout",
  "AddToCart",
  "ViewContent",
  "OrderCreated",
  "OrderShipped",
  "OrderDelivered",
  "OrderCanceled",
  "OrderReturned",
  "CartAbandoned",
  "RatingProvided",
  "ReviewProvided",
] as const;

export type MetaBusinessMessagingEvent =
  (typeof META_BUSINESS_MESSAGING_EVENTS)[number];

export function isMetaBusinessMessagingEvent(
  name: string
): name is MetaBusinessMessagingEvent {
  return (META_BUSINESS_MESSAGING_EVENTS as readonly string[]).includes(name);
}

/**
 * A Meta responde 200 mesmo que não tenha contabilizado nada: `events_received` é o
 * único aviso real. Sem olhar para ele, "enviado" só significaria "não houve um HTTP
 * de erro", e um evento descartado em silêncio pareceria idêntico a um bom.
 */
export type CapiAck = {
  eventsReceived: number;
  fbTraceId: string | null;
  /** Resposta crua: quando algo não bate, o `messages[]` da Meta diz mais. */
  raw: unknown;
};

export async function sendBusinessMessagingEvent(input: {
  datasetId: string;
  token: string;
  event: BusinessMessagingEvent;
}): Promise<CapiAck> {
  // Validar ANTES de montar o payload: um nome fora do catálogo é rejeitado
  // com um 400 opaco, então falha-se aqui e com o motivo escrito.
  if (!isMetaBusinessMessagingEvent(input.event.eventName)) {
    throw new Error(
      `"${input.event.eventName}" no está en el catálogo de eventos ` +
        `business_messaging de Meta (${META_BUSINESS_MESSAGING_EVENTS.join(", ")})`
    );
  }

  const res = await graphRequest<{
    events_received?: number;
    fbtrace_id?: string;
  }>(`${input.datasetId}/events`, {
    method: "POST",
    token: input.token,
    body: buildEventPayload(input.event),
  });

  const eventsReceived = res?.events_received ?? 0;
  if (eventsReceived < 1) {
    // 200 com zero recebidos: a Meta descartou. Falha-se para que a linha fique
    // `failed` com o motivo, em vez de um `sent` que mente.
    throw new Error(
      `Meta respondió 200 pero events_received=${eventsReceived} ` +
        `(evento descartado; fbtrace_id: ${res?.fbtrace_id ?? "n/d"})`
    );
  }

  return {
    eventsReceived,
    fbTraceId: res?.fbtrace_id ?? null,
    raw: res,
  };
}

/**
 * Monta o body de `POST {dataset}/events`. Separada e exportada para poder
 * fixar a FORMA do payload em um teste: o modo de falhar deste endpoint é
 * um 200 com `events_received: 0`, onde um campo mal colocado parece exatamente
 * igual a um colocado corretamente.
 */
export function buildEventPayload(
  event: BusinessMessagingEvent
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    event_name: event.eventName,
    event_time: event.eventTime,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    // Para a Meta NÃO vai telefone, nome nem texto do contato: só o
    // identificador do clique e o da conta de WhatsApp do negócio.
    user_data: {
      ctwa_clid: event.ctwaClid,
      whatsapp_business_account_id: event.wabaId,
    },
  };

  // É omitido se ficar vazio: enviar `custom_data: {}` não traz nada configurável e
  // suja o payload que se inspeciona quando algo falha.
  if (event.customData && Object.keys(event.customData).length > 0) {
    data.custom_data = event.customData;
  }

  return { data: [data], partner_agent: PARTNER_AGENT };
}
