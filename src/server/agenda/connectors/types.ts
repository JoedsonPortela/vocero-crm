import type { ConnectorId } from "@/lib/agenda-connectors";

/**
 * 015 — O contrato público de um conector de agenda.
 *
 * Deliberadamente pequeno: QUATRO operações, medidas do uso real em
 * produção da integração do Zoom do fork de agência — nem uma a mais em
 * meses de operação. Ver specs/015-motor-agenda-universal/contracts/conector.md.
 *
 * O que NÃO está aqui e é de propósito: ler a disponibilidade alheia (free/busy).
 * A disponibilidade é calculada 100% localmente, com uma consulta e aritmética; meter o
 * provedor nesse caminho acoplaria sua latência e suas quedas à tela que
 * mais se usa. Os compromissos de fora são refletidos com bloqueios manuais.
 *
 * Regras que o MOTOR impõe, não cada conector:
 *  1. Os efeitos rodam DEPOIS de gravar a verdade no CRM e são
 *     best-effort: uma exceção daqui jamais reverte nem bloqueia o agendamento.
 *  2. Um agendamento de teste do Laboratório NUNCA chega até aqui — a asserção
 *     vive antes da bifurcação por conector. Um conector não verifica
 *     `is_test`: não lhe diz respeito.
 */

export type MeetingRequest = {
  /** "Agendamento — <nome do contato>". */
  topic: string;
  /** Instante UTC ISO-8601 com Z. */
  startUtc: string;
  durationMinutes: number;
  /** Fuso IANA do negócio: o provedor o usa para mostrá-lo aos seus. */
  timezone: string;
  notes?: string;
};

export type MeetingResult = {
  /** Id da reunião/evento no provedor; null se não gera um. */
  externalId: string | null;
  /** O que se compartilha com o cliente; null se este conector não dá link. */
  joinUrl: string | null;
};

export type TestConnectionResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string };

export type AgendaConnector<Creds> = {
  id: ConnectorId;
  /** Precisa de credenciais guardadas para operar? */
  requiresCredentials: boolean;

  createMeeting(creds: Creds, req: MeetingRequest): Promise<MeetingResult>;

  updateMeeting(
    creds: Creds,
    externalId: string,
    req: Pick<MeetingRequest, "startUtc" | "durationMinutes" | "timezone">
  ): Promise<void>;

  /** Idempotente: um 404 do provedor é sucesso (já não estava). */
  deleteMeeting(creds: Creds, externalId: string): Promise<void>;

  testConnection(creds: Creds): Promise<TestConnectionResult>;

  /**
   * OPCIONAL: relê uma reunião já criada.
   *
   * Existe pelos provedores que geram o link de forma assíncrona
   * (o Google cria a conferência em segundo plano e sua resposta imediata
   * pode vir `pending`). Sem isto, "Tentar novamente o link" sobre um agendamento que já
   * tem evento criaria um DUPLICADO na agenda do dono.
   *
   * Um conector cujo link chega de imediato —Zoom— não precisa dela.
   */
  refreshMeeting?(creds: Creds, externalId: string): Promise<MeetingResult>;
};

/**
 * Erro de um conector. `isAuthError` não é decorativo: quando é true, o
 * motor marca a credencial como quebrada e a UI mostra o cartão de
 * reconexão. No fork existe um helper igual que ninguém consome e um estado
 * `error` que nunca é escrito — o aviso não chega e o dono descobre pelo
 * cliente que não recebeu seu link.
 */
export class ConnectorError extends Error {
  readonly connectorId: ConnectorId;
  readonly status: number | null;
  readonly isAuthError: boolean;

  constructor(
    connectorId: ConnectorId,
    message: string,
    opts?: { status?: number | null; isAuthError?: boolean }
  ) {
    super(message);
    this.name = "ConnectorError";
    this.connectorId = connectorId;
    this.status = opts?.status ?? null;
    // Critério estrito: SOMENTE 401. O helper do fork trata qualquer 400 como
    // problema de credenciais, e um 400 de validação marcaria a conexão
    // como quebrada sem estar.
    this.isAuthError = opts?.isAuthError ?? opts?.status === 401;
  }
}
