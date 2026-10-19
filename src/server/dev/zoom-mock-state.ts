/**
 * 015 — Estado do mock do Zoom (somente ambiente de testes).
 *
 * Existe para que o self-test possa AFIRMAR sobre o que o CRM enviou ao
 * provedor —não só que a requisição não falhou—: qual reunião foi criada, que
 * movê-la usou o mesmo id, e que cancelá-la a apagou. E para que o sandbox
 * do Laboratório possa ser verificado por ausência: após uma execução de teste,
 * este estado tem que estar VAZIO.
 */

export type MockMeeting = {
  id: string;
  topic: string;
  startTime: string;
  duration: number;
  timezone: string;
  joinUrl: string;
  updates: number;
};

type MockState = {
  meetings: Map<string, MockMeeting>;
  deleted: string[];
  nextId: number;
};

const globalForMock = globalThis as unknown as { __zoomMock?: MockState };

export function zoomMockState(): MockState {
  if (!globalForMock.__zoomMock) {
    globalForMock.__zoomMock = { meetings: new Map(), deleted: [], nextId: 1 };
  }
  return globalForMock.__zoomMock;
}

export function resetZoomMock(): void {
  const s = zoomMockState();
  s.meetings.clear();
  s.deleted.length = 0;
  s.nextId = 1;
}

export function zoomMockSnapshot() {
  const s = zoomMockState();
  return {
    meetings: [...s.meetings.values()],
    deleted: [...s.deleted],
  };
}

/**
 * O caminho infeliz, determinista: um segredo terminado em `-invalid` faz com
 * que o mock rejeite a autenticação. Sem isto, o self-test só poderia testar
 * que tudo sai bem — e o que precisa ser testado é que, quando o provedor
 * falha, o agendamento é criado mesmo assim.
 */
export function mockCredentialsAreBad(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Basic ")) return true;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  return decoded.endsWith("-invalid");
}
