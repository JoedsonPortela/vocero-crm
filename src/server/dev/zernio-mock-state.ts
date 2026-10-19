/**
 * 017 — Estado em memória do mock da Zernio (somente dev/teste). Vive no
 * globalThis porque o Next recarrega módulos em dev; uma instância = um processo,
 * então o outbox em memória basta para as asserções do self-test.
 */

export type ZernioSentMessage = {
  n: number;
  conversationId: string;
  accountId: string | null;
  message: string;
  /** Presente somente fora da janela de 24 h. */
  messagingType?: string;
  messageTag?: string;
  /** Chave de idempotência com a qual chegou, se houve. */
  idempotencyKey: string | null;
  at: string;
};

/** 023: uma conta de `GET /accounts`, com a forma real dessa API. */
export type ZernioMockAccount = {
  _id: string;
  platform: string;
  username?: string | null;
  displayName?: string | null;
  platformUserId?: string | null;
  isActive?: boolean;
  needsReconnection?: boolean;
  platformStatus?: string | null;
  tiktokAccountType?: string | null;
  profileId?: { _id: string } | null;
  metadata?: { selectedPageId?: string; selectedPageName?: string } | null;
};

/** 023: um webhook de `/webhooks/settings`. */
export type ZernioMockWebhook = {
  _id: string;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  isActive: boolean;
  accountIds: string[];
  failureCount: number;
  lastFiredAt: string | null;
};

type ZernioMockState = {
  seq: number;
  sent: ZernioSentMessage[];
  /** 023 */
  accounts: ZernioMockAccount[];
  webhooks: ZernioMockWebhook[];
  /** Rotas que respondem 503 até o próximo `_reset` (p. ex. "webhooks/settings"). */
  down: string[];
  /** Quantas vezes se leu cada rota, para afirmar sobre o cache. */
  hits: Record<string, number>;
};

const g = globalThis as unknown as { __voceroZernioMock?: ZernioMockState };

export function zernioMockState(): ZernioMockState {
  if (!g.__voceroZernioMock) {
    g.__voceroZernioMock = { seq: 0, sent: [], accounts: [], webhooks: [], down: [], hits: {} };
  }
  // Um processo que vinha de antes da 023 (recarga a quente).
  const s = g.__voceroZernioMock;
  s.accounts ??= [];
  s.webhooks ??= [];
  s.down ??= [];
  s.hits ??= {};
  return s;
}

/** Esvazia o enviado. O contador NÃO se reinicia: ver `nextZernioMessageId`. */
export function resetZernioMock(): void {
  // As contas e os webhooks NÃO são esvaziados: são o cenário, e o arnês o
  // muda com `_accounts` e `_webhooks` quando quer outro.
  const s = zernioMockState();
  s.sent = [];
  s.down = [];
  s.hits = {};
}

/**
 * Id da mensagem que o mock devolve ao CRM.
 *
 * Leva a marca de tempo do processo, não só um contador: o CRM guarda esse
 * id com um índice ÚNICO, então duas execuções do arnês contra o mesmo BD
 * colidiriam com `zmock_1` e o envio falharia por uma colisão do harness,
 * que se vê igual a um bug do produto.
 */
export function nextZernioMessageId(): string {
  const state = zernioMockState();
  return `zmock_${Date.now().toString(36)}_${++state.seq}`;
}

/**
 * Uma chave que termina em `-invalid` é recusada, igual faz o mock do
 * Graph: é assim que o arnês comprova que credenciais ruins NÃO são guardadas.
 */
export function zernioTokenIsBad(authorization: string | null): boolean {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "");
  return token.length === 0 || token.endsWith("-invalid");
}
