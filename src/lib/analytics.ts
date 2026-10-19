import type { LossReason, SourceValue, StageDto } from "@/lib/types";

/**
 * 019 — Contratos e aritmética da tela Resultados.
 *
 * Portado do Vocero Cloud (101 W6 + a tabela por anúncio de 212) SEM gasto
 * publicitário: fora a carga manual, o custo por prospect e o retorno
 * (decisão do dono, spec 019 D1). O de origem e anúncios trafega em contagens.
 *
 * Vive em `lib/` e não em `server/` porque as seções são desenhadas no
 * cliente e não podem arrastar o BD para o bundle — mesmo critério que
 * `lib/money.ts`.
 */

export type StageKind = StageDto["kind"];

/** Abaixo desta amostra, uma porcentagem é uma anedota. */
export const MIN_SAMPLE = 10;

/**
 * Toda taxa da tela passa por aqui.
 *
 * São mais de dez distribuídas em quatro blocos, e cada uma é uma oportunidade
 * de dividir por zero, de apresentar um 100 % sustentado em um único caso, ou de
 * mostrar a porcentagem sem o número absoluto que a torna interpretável. Um
 * único helper transforma essas três regras em algo que não se pode esquecer.
 * **A UI não divide.**
 */
export type RateDto = {
  /** Porcentagem inteira 0-100, ou `null` se não houver denominador. */
  value: number | null;
  /** O denominador: é mostrado SEMPRE junto à porcentagem. */
  sample: number;
  /** false = amostra pequena; a UI marca isso em vez de apresentar como firme. */
  reliable: boolean;
};

export function rate(numerator: number, denominator: number): RateDto {
  if (denominator <= 0) return { value: null, sample: 0, reliable: false };
  return {
    value: Math.round((numerator / denominator) * 100),
    sample: denominator,
    reliable: denominator >= MIN_SAMPLE,
  };
}

/** Um número do período e o mesmo número do período anterior. */
export type Comparable = { current: number; previous: number };

export function comparable(current: number, previous: number): Comparable {
  return { current, previous };
}

/** Variação percentual; `null` quando não há base para comparar. */
export function delta(c: Comparable): number | null {
  if (c.previous === 0) return null;
  return Math.round(((c.current - c.previous) / c.previous) * 100);
}

export type PeriodDto = {
  /** `YYYY-MM-DD` no fuso horário do negócio. */
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  timezone: string;
  /** Como a série é agrupada: por dia em intervalos curtos, por mês em longos. */
  granularity: "day" | "month";
  days: number;
};

/**
 * Todos os baldes do período, em ordem. Um dia sem movimentos é um zero no
 * gráfico, não um buraco: sem ele, as barras de terça e de sexta ficariam
 * juntas e a série mentiria sobre o ritmo.
 */
export function bucketsDelPeriodo(
  p: Pick<PeriodDto, "from" | "to" | "granularity">
): string[] {
  const out: string[] = [];
  if (p.granularity === "month") {
    let y = Number(p.from.slice(0, 4));
    let m = Number(p.from.slice(5, 7));
    const ty = Number(p.to.slice(0, 4));
    const tm = Number(p.to.slice(5, 7));
    // Limite defensivo: o intervalo máximo é de 366 dias (13 meses no máximo).
    while ((y < ty || (y === ty && m <= tm)) && out.length < 24) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }
  const fin = Date.parse(`${p.to}T00:00:00Z`);
  for (
    let t = Date.parse(`${p.from}T00:00:00Z`);
    t <= fin && out.length < 400;
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/* ── Vendas e funil ────────────────────────────────────────────── */

export type FunnelStepDto = {
  stageId: string | null;
  name: string;
  kind: StageKind;
  /** Leads que ALCANÇARAM esta etapa, contados uma única vez por lead. */
  reached: number;
  /** Qual proporção dos que chegaram aqui passou para a seguinte. */
  advanceRate: RateDto | null;
};

export type StageTimingDto = {
  stageId: string | null;
  name: string;
  avgDays: number | null;
  sample: number;
};

export type LossReasonRowDto = {
  reason: LossReason | "sin_registro";
  label: string;
  count: number;
};

export type SalesBlockDto = {
  period: PeriodDto;
  kpis: {
    newLeads: Comparable;
    won: Comparable;
    lost: Comparable;
    wonCents: Comparable;
    winRate: RateDto;
    avgTicketCents: number | null;
  };
  /**
   * O funil de HOJE, não do período. Sem «dinheiro esperado»: a probabilidade
   * de fechamento que é calculada no Cloud não existe na raiz (spec 019, D5).
   */
  pipeline: {
    openCents: number;
    /** Leads em etapas abertas que ainda não têm valor registrado. */
    withoutAmount: number;
    /** Leads excluídos do total por estarem em outra moeda. */
    otherCurrency: number;
  };
  series: { bucket: string; newLeads: number; won: number; wonCents: number }[];
  funnel: FunnelStepDto[];
  timing: StageTimingDto[];
  timeToWinDays: number | null;
  /**
   * Data desde a qual o histórico é completo. Antes dela há eventos
   * semeados pela migração e os tempos não são calculados. `null` se nunca
   * houve eventos semeados: então não há nada a advertir.
   */
  completeFrom: string | null;
  lossReasons: LossReasonRowDto[];
  /** true = NÃO houve NADA no período; a UI diz isso em vez de desenhar zeros. */
  empty: boolean;
};

/* ── Origem e anúncios (somente contagens) ───────────────────────── */

export type SourceKey = SourceValue | "desconocida";

export type SourceRowDto = {
  value: SourceKey;
  label: string;
  /** Conversas que COMEÇARAM no período. */
  conversations: number;
  /** Prospects (leads) criados no período. */
  leads: number;
  /** Desses prospects, quantos estão hoje em Ganado. */
  won: number;
  winRate: RateDto;
};

/** 018 — Prospects do período pelo anúncio que os trouxe. */
export type AdRowDto = {
  /** `source_id`, ou o id da linha de origem se a Meta não enviou nenhum. */
  key: string;
  sourceId: string | null;
  /** `post` se foi uma publicação e não um anúncio. */
  sourceType: string | null;
  headline: string | null;
  /** Imagem do criativo, servida por `/api/media/{id}`. */
  imageAssetId: string | null;
  conversations: number;
  leads: number;
  won: number;
  winRate: RateDto;
};

export type AdsBlockDto = {
  period: PeriodDto;
  /** Conversas que começaram no período, em comparação com o anterior. */
  conversations: Comparable;
  /** Qual parte dessas conversas chegou com origem «anúncio». */
  adShare: RateDto;
  sources: SourceRowDto[];
  ads: AdRowDto[];
  empty: boolean;
};

/* ── O trabalho do agente ──────────────────────────────────────── */

export type LabeledCountDto = { key: string; label: string; count: number };

export type SessionsDto = {
  booked: number;
  done: number;
  noShow: number;
  cancelled: number;
  showRate: RateDto;
};

export type BotBlockDto = {
  period: PeriodDto;
  /** Conversas que começaram no período. */
  conversations: number;
  /** Das que têm mensagem do cliente, em quantas o agente respondeu. */
  aiReplyRate: RateDto;
  /** Mediana em segundos; `null` se não houve nenhuma resposta a medir. */
  firstResponseSeconds: number | null;
  firstResponseSample: number;
  /** Das conversas do período, as que passaram para um humano. */
  handoffs: LabeledCountDto[];
  handoffRate: RateDto;
  /** `null` com a flag AGENDA desligada: sem agenda não há agendamentos a contar. */
  sessions: SessionsDto | null;
  /**
   * Quantos contatos têm ficha. `null` quando o perfil do agente não a
   * escreve: não é 0 %, é que essa medida não se aplica nesta instalação.
   */
  fichaCoverage: RateDto | null;
  empty: boolean;
};

/* ── Higiene (o agora, sem intervalo) ──────────────────────────── */

export type HygieneBlockDto = {
  /** Os primeiros da lista; `silentCount` diz quantos são no total. */
  silent: {
    leadId: string;
    contactId: string;
    name: string;
    days: number;
    amountCents: number | null;
  }[];
  silentCount: number;
  /** Dinheiro de TODOS os leads em silêncio, na moeda do negócio. */
  silentAmountCents: number;
  failedMessages: { error: string; count: number; lastAt: string }[];
  closingWindows: {
    conversationId: string;
    contactId: string;
    name: string;
    hoursLeft: number;
  }[];
  clean: boolean;
};

/* ── Rótulos ──────────────────────────────────────────────────── */

/** As mesmas palavras da ficha do contato e do painel da bandeja. */
export const HANDOFF_LABEL: Record<string, string> = {
  cliente: "El cliente pidió un humano",
  modelo: "El agente decidió escalar",
  error: "Error del proveedor de IA",
  ventana: "Ventana de 24 h cerrada",
  hostilidad: "El cliente se puso agresivo",
  manual_reply: "Respondiste desde el teléfono",
};
