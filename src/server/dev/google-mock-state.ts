/**
 * 015 — Estado do mock do Google Calendar (somente ambiente de testes).
 *
 * Imita a parte que mais custa acreditar até ser vista: a conferência do Meet
 * NÃO vem na resposta de criar o evento. Aqui o primeiro `GET` do evento
 * ainda a dá como pendente e o seguinte já traz o link — assim o
 * self-test exercita o caminho real, não um confortável.
 */

export type MockEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  /** Quantas vezes foi lido: a conferência "termina" após a primeira. */
  reads: number;
  meetLink: string | null;
  updates: number;
};

type MockState = {
  events: Map<string, MockEvent>;
  deleted: string[];
  nextId: number;
  /** Leituras que a conferência leva para estar pronta. */
  conferenceDelayReads: number;
};

const globalForMock = globalThis as unknown as { __googleMock?: MockState };

export function googleMockState(): MockState {
  if (!globalForMock.__googleMock) {
    globalForMock.__googleMock = {
      events: new Map(),
      deleted: [],
      nextId: 1,
      conferenceDelayReads: 1,
    };
  }
  return globalForMock.__googleMock;
}

export function resetGoogleMock(): void {
  const s = googleMockState();
  s.events.clear();
  s.deleted.length = 0;
  s.nextId = 1;
  s.conferenceDelayReads = 1;
}

export function googleMockSnapshot() {
  const s = googleMockState();
  return {
    events: [...s.events.values()],
    deleted: [...s.deleted],
  };
}

/**
 * Caminho infeliz determinista: um refresh token terminado em `-invalid` faz
 * com que o Google responda `invalid_grant` — exatamente o que acontece quando o app
 * OAuth continua em modo de teste e expirou após 7 dias.
 */
export function mockRefreshTokenIsBad(body: string): boolean {
  return new URLSearchParams(body).get("refresh_token")?.endsWith("-invalid") ?? true;
}
