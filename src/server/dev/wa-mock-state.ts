/**
 * Estado em memória do harness wa-mock (somente dev/teste). Vive no globalThis
 * porque o Next recarrega módulos em dev; uma instância = um processo, então o
 * outbox em memória basta para as asserções do self-test.
 */

export type OutboxEntry = {
  n: number;
  phoneNumberId: string;
  to: string;
  /**
   * O BSUID, quando o destinatário ia por `recipient` em vez de `to`.
   *
   * Expõe-se para que um self-test possa comprovar EM QUE CAMPO viajou: é a
   * única diferença entre o envio que a Meta aceita e o que devolve 131026.
   */
  recipient?: string;
  type: string;
  body: unknown;
  at: string;
  /**
   * Id que foi devolvido ao CRM. O outbox o expõe para que um self-test
   * possa mandar um webhook de status a ESSA mensagem sem adivinhar o formato.
   */
  waMessageId?: string;
};

export type MockTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  body: string;
  /** Componentes tal como os enviou o CRM: a Meta valida aqui os `example`. */
  components?: unknown[];
};

/**
 * 016 — Um evento da Conversions API que o CRM enviou ao mock. O self-test
 * o inspeciona para verificar a FORMA do payload: o modo de falhar desse
 * endpoint é um 200 com `events_received: 0`, onde um campo mal colocado se vê
 * idêntico a um bem colocado.
 */
export type CapiMockEvent = {
  n: number;
  datasetId: string;
  eventName: string;
  ctwaClid: string | null;
  customData: Record<string, unknown> | null;
  body: unknown;
  at: string;
};

/**
 * A inscrição do app em uma WABA (`{WABA}/subscribed_apps`), com seu
 * override de callback se alguém o configurou. Existe para que o self-test
 * possa comprovar que salvar a conexão NÃO apaga o override de um cérebro
 * externo: na Meta, um POST sem corpo o elimina, e o mock faz o mesmo.
 */
export type MockWabaSubscription = {
  overrideCallbackUri: string | null;
};

type WaMockState = {
  outbox: OutboxEntry[];
  templates: MockTemplate[];
  capiEvents: CapiMockEvent[];
  /** Por WABA ID. Sem entrada = o app não está inscrito nessa WABA. */
  wabaSubscriptions: Record<string, MockWabaSubscription>;
  /**
   * Override de webhook por NÚMERO: phone_number_id → callback URL. É o que
   * o CRM registra ao salvar a conexão; o self-test o lê para comprovar
   * que ficou configurado (e que desconectar o remove) sem olhar dentro do CRM.
   */
  phoneWebhooks: Record<string, string>;
  counter: number;
};

const globalForMock = globalThis as unknown as { __waMockState?: WaMockState };

function freshState(): WaMockState {
  return {
    outbox: [],
    templates: [],
    capiEvents: [],
    wabaSubscriptions: {},
    phoneWebhooks: {},
    counter: 0,
  };
}

export function getWaMockState(): WaMockState {
  if (!globalForMock.__waMockState) {
    globalForMock.__waMockState = freshState();
  }
  // Um processo de `next dev` que já tinha o estado antigo em memória.
  globalForMock.__waMockState.phoneWebhooks ??= {};
  return globalForMock.__waMockState;
}

export function resetWaMockState(): void {
  // O contador não volta a zero. O carimbo de `nextOutboundWamid` é por
  // processo, então reiniciá-lo aqui repetia ids já guardados: a segunda
  // execução de um arnês contra o mesmo `next dev` colidia com o UNIQUE de
  // `wa_message_id` e o turno falhava ao enviar.
  const counter = globalForMock.__waMockState?.counter ?? 0;
  globalForMock.__waMockState = { ...freshState(), counter };
}

export function nextN(): number {
  return ++getWaMockState().counter;
}

/**
 * Carimbo único por inicialização do processo. Sem ele, o contador do mock reinicia
 * ao reiniciar `pnpm dev` e volta a emitir `wamid.mock.out.1`, que colide com
 * o UNIQUE de `wa_message_id` no BD de uma execução anterior (500 ao
 * enviar). Não é uma falha do produto: a idempotência faz o seu trabalho.
 */
const boot = Math.random().toString(36).slice(2, 8);

export function nextOutboundWamid(): string {
  return `wamid.mock.out.${boot}.${nextN()}`;
}
