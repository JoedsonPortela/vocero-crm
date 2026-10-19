/**
 * «Quem responde aos seus clientes»: o contrato entre
 * `GET /api/agent/brain-status` e a UI (o cartão do Agente e o painel de
 * contato). Somente tipos e textos: os componentes de cliente os importam, então
 * aqui não entra nada de servidor. O cálculo vive em `server/bot/status.ts`.
 *
 * Por que existe: o agente incluído e um cérebro externo (Nea) não se veem
 * entre si. Se os dois estiverem ativos, o cliente recebe DUAS respostas
 * diferentes à mesma mensagem, e até agora nada no CRM dizia isso.
 */

/** Os modos da Nea tal como são reportados pelo seu `/health`. */
export const BRAIN_MODES = ["estándar", "cloud", "multiorg"] as const;
export type BrainMode = (typeof BRAIN_MODES)[number];

/** Por que o `/health` do cérebro externo não conta como «en línea». */
export type BrainHealthProblem =
  /** Não respondeu dentro do limite (2 s). */
  | "timeout"
  /** Não foi possível conectar: nome que não resolve, porta fechada… */
  | "network"
  /** Respondeu com um código diferente de 200 (`httpStatus`). */
  | "status"
  /** Respondeu com um redirecionamento; não é seguido. */
  | "redirect"
  /** 200, mas sem JSON ou sem dizer que está saudável. */
  | "invalid"
  /** `BRAIN_HEALTH_URL` não é uma URL http(s): ninguém foi consultado. */
  | "config";

/** A fila da Nea em direção ao CRM (o «revezamento» dos webhooks). */
export type BrainRelayDto = {
  /** Mensagens recebidas que aguardam chegar ao CRM. */
  pendientes: number | null;
  masViejoSegundos: number | null;
  ultimoErrorEn: string | null;
};

export type BrainHealthDto = {
  reachable: boolean;
  /** Somente host[:porta]: jamais credenciais, caminho nem query da URL. */
  host: string;
  checkedAt: string;
  problem?: BrainHealthProblem;
  httpStatus?: number;
  version?: string;
  commit?: string;
  commitVerified?: boolean;
  mode?: BrainMode;
  relay?: BrainRelayDto;
};

export type BrainWarning = "doble_respuesta" | "sin_cerebro";

/**
 * 021 — O despacho: o CRM empurra cada turno ao cérebro externo
 * (`BRAIN_DISPATCH_URL`). Os fatos saem da tabela `dispatch`, então
 * sobrevivem a um reinício.
 */
export type BrainDispatchDto = {
  /** URL válida e `BOT_API_KEY`: o CRM está empurrando turnos. */
  active: boolean;
  /** Somente host[:porta]. `null` sem `BRAIN_DISPATCH_URL` ou se não for uma URL. */
  host: string | null;
  /** `url`: não é http(s) ou leva usuário e senha. `sin_llave`: falta
   *  `BOT_API_KEY`. Com problema, o despacho NÃO está ativo. */
  problem: "url" | "sin_llave" | null;
  lastDeliveredAt: string | null;
  /** O último turno que não chegou (expirou) ou que continua sendo reenviado. */
  lastFailure: { at: string; detail: string } | null;
  /** Turnos aguardando a sua janela ou uma nova tentativa. */
  pending: number;
};

/** O que devolve uma instância que não despacha. */
export const SIN_DESPACHO: BrainDispatchDto = {
  active: false,
  host: null,
  problem: null,
  lastDeliveredAt: null,
  lastFailure: null,
  pending: 0,
};

export type BrainStatusDto = {
  embedded: {
    /** A organização tem provedor de IA: o salvo em Ajustes → IA
     *  ou, como reserva, `OPENROUTER_API_TOKEN` no ambiente. */
    configured: boolean;
    /** O interruptor do Agente. */
    enabled: boolean;
    answering: boolean;
    /** 021: teria com que responder, mas o despacho o silencia. */
    silenced: boolean;
  };
  external: {
    /** `BOT_API_KEY` válida: a API `/api/bot/*` está aberta. */
    keyConfigured: boolean;
    /** Última chamada autenticada a `/api/bot/*`. Em memória: conta
     *  desde a última inicialização do CRM. */
    lastSeenAt: string | null;
    /** Parece estar respondendo: chamou nas últimas 24 h, seu `/health`
     *  está online, ou o CRM está despachando turnos para ele. */
    active: boolean;
    /** `null` se não houver `BRAIN_HEALTH_URL`: ninguém é consultado. */
    health: BrainHealthDto | null;
  };
  /** 021: o despacho do CRM para o cérebro. */
  dispatch: BrainDispatchDto;
  warning: BrainWarning | null;
};

/**
 * O nome que pode ser afirmado. «Nea» só se o seu `/health` fala o
 * contrato da Nea (traz `mode`); com um bot próprio ou uma Nea antiga não
 * se inventa nenhum.
 */
export function externalBrainName(status: BrainStatusDto): string | null {
  return status.external.health?.mode ? "Nea" : null;
}

/**
 * Até onde o CRM consegue saber, o cérebro externo está respondendo: está
 * ativo e, se for consultado o seu `/health`, não está fora do ar. `active` puro
 * serve para o aviso de dupla resposta (melhor avisar demais); para dizer
 * ao dono «responde seu cérebro externo» é preciso isto.
 */
export function externalAnswering(status: BrainStatusDto): boolean {
  const h = status.external.health;
  return status.external.active && (!healthKnown(h) || h.reachable);
}

/** Consulta-se o seu `/health` e não está online. */
export function externalDown(status: BrainStatusDto): boolean {
  const h = status.external.health;
  return healthKnown(h) && !h.reachable;
}

/** O seu `/health` diz algo. Com `BRAIN_HEALTH_URL` escrita errada não foi possível
 *  consultar: não se sabe se está online, e é julgado como se não houvesse URL
 *  (pela sua última chamada), não como fora do ar. */
function healthKnown(h: BrainHealthDto | null): h is BrainHealthDto {
  return h !== null && h.problem !== "config";
}

/** «Responde tu cerebro externo (Nea)», ou sem parênteses se não se sabe quem é. */
export function externalAnswerLabel(status: BrainStatusDto): string {
  const name = externalBrainName(status);
  return name
    ? `Responde tu cerebro externo (${name})`
    : "Responde tu cerebro externo";
}

/** «hace 3 min». Tolera relógios defasados: o futuro é «hace unos segundos». */
export function haceCuanto(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s) || s < 60) return "hace unos segundos";
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "hace 1 día" : `hace ${d} días`;
}

/**
 * 021 — O último turno não chegou ao cérebro e desde então nenhum chegou.
 * Uma falha antiga, com entregas depois, já não é um alarme.
 */
export function despachoFallando(d: BrainDispatchDto): boolean {
  if (!d.active || !d.lastFailure) return false;
  if (!d.lastDeliveredAt) return true;
  return Date.parse(d.lastFailure.at) > Date.parse(d.lastDeliveredAt);
}
