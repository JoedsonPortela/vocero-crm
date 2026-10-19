import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { getEnv } from "@/lib/env";
import { chatJson, type ChatMessage } from "@/lib/ai";
import { isAiConfiguredFor } from "@/lib/ai/provider";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { windowMsFor } from "@/server/channels/capabilities";
import { SendError, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { HANDOFF_BACKUP_ACK, matchesHandoffIntent } from "@/server/ai/handoff";
import {
  buildAgentSystemPrompt,
  TURN_FORMAT_REMINDER,
} from "@/server/ai/prompts";
import {
  atendidoPorPersona,
  debidosVigentes,
  ordenarParaElTurno,
  quedanDebidos,
} from "@/server/ai/orden-turno";
import { agendaEnabled } from "@/server/agenda/flag";
import { bookSlot, offerSlots } from "@/server/agenda/agent";
import { getOffers, mapaDeHuecosParaModelo } from "@/server/agenda/offers";

/**
 * Turno do agente (FR-021..FR-025).
 *
 * Coalesce + lock em processo por conversa: rajadas de mensagens viram UMA
 * resposta; nunca dois turnos simultâneos; o que chega durante um turno
 * reenfileira exatamente mais um turno. Suficiente para o monólito de uma
 * instância (sem filas externas — Constituição II).
 *
 * 025 — A entrada também traz quais mensagens o próximo turno DEVE atender. O que
 * o cliente escreve enquanto o modelo pensa fica, por hora, antes da
 * resposta que sai desse turno; sem essa conta, o turno seguinte lê uma
 * conversa que termina na própria resposta. É a mesma memória que o
 * despacho guarda em `dispatch.message_ids`, aqui em processo, como `pending`.
 */

type CoalesceEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
  /** Mensagens anotadas para o próximo turno. */
  debidos: Set<string>;
};

const globalForAgent = globalThis as unknown as {
  __agentCoalesce?: Map<string, CoalesceEntry>;
};

function coalesceMap(): Map<string, CoalesceEntry> {
  if (!globalForAgent.__agentCoalesce) {
    globalForAgent.__agentCoalesce = new Map();
  }
  return globalForAgent.__agentCoalesce;
}

/**
 * Ponto de entrada com debounce (mensagens recebidas reais). `messageId` é
 * a mensagem que o provoca.
 */
export function scheduleAgentTurn(
  conversationId: string,
  messageId: string
): void {
  const map = coalesceMap();
  const entry = map.get(conversationId) ?? {
    timer: null,
    running: false,
    pending: false,
    debidos: new Set<string>(),
  };
  map.set(conversationId, entry);
  entry.debidos.add(messageId);

  if (entry.running) {
    entry.pending = true; // se reenfileira ao terminar o turno atual
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  const delay = getEnv().AGENT_COALESCE_MS;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void executeTurn(conversationId);
  }, delay);
}

async function executeTurn(conversationId: string): Promise<void> {
  const map = coalesceMap();
  const entry = map.get(conversationId);
  if (!entry || entry.running) return;
  entry.running = true;
  // O que foi anotado até aqui é deste turno. O que entrar a partir de agora cai
  // num conjunto novo: é o que, ao terminar, pode continuar pendente.
  const deEsteTurno = [...entry.debidos];
  entry.debidos = new Set();
  let leido: TurnoLeido | undefined;
  try {
    leido = await runAgentTurn(conversationId, { debidos: deEsteTurno });
  } catch (err) {
    console.error("[agente] turno falló:", err);
  } finally {
    entry.running = false;
    // Se o turno não chegou a ler (falhou ou parou antes de abrir o
    // histórico), o que ele trazia continua pendente.
    if (!leido) for (const id of deEsteTurno) entry.debidos.add(id);
    // E se leu, o que entrou nesse meio-tempo e chegou a ver já está
    // atendido: repetir o turno seria responder duas vezes.
    const quedan = quedanDebidos(entry.debidos, leido?.vistos);
    entry.debidos = new Set(quedan);
    const repetir = entry.pending && quedan.length > 0;
    entry.pending = false;
    if (repetir) {
      void executeTurn(conversationId);
    } else {
      map.delete(conversationId);
    }
  }
}

/** O que o turno chegou a ler. Ausente se não chegou a abrir o histórico. */
export type TurnoLeido = { vistos: string[] };

/**
 * Executa UM turno do agente agora (o Laboratório chama direto, com
 * debounce 0 e sem passar pelo coalesce).
 *
 * 025 — `debidos` são as mensagens que este turno precisa atender; só elas
 * passam pelo coalesce. Retorna quais mensagens leu: quem chamou compara
 * com o que entrou enquanto o modelo pensava, que o turno não pôde ver.
 */
export async function runAgentTurn(
  conversationId: string,
  opciones: { debidos?: readonly string[] } = {}
): Promise<TurnoLeido | undefined> {
  const db = getDb();
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  // Esta organização tem IA? O salvo em Configurações → IA ou, se não, o
  // ambiente. Sem provedor, ou com a chave pausada pelo provedor, a
  // mensagem fica na caixa de entrada para ser atendida por uma pessoa — e o
  // dono vê o motivo no banner e em Configurações → IA. Vem ANTES de qualquer
  // efeito (transferências por janela ou por frase): sem IA não há turno.
  if (!(await isAiConfiguredFor(organizationId))) return;

  // Condições de silêncio: handoff ativo ou IA desligada na conversa.
  if (conversation.handoffAt || !conversation.aiEnabled) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return;
  // O interruptor global vale para conversas reais; o Laboratório avalia o
  // comportamento configurado mesmo que o agente ainda não esteja ligado.
  if (!conversation.isTest && !profile.enabled) return;

  const recientes = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(desc(schema.message.createdAt))
    .limit(20);
  recientes.reverse();
  // Por id e não só «as últimas 20»: uma mensagem pendente que já não caiba nessa
  // janela continuaria pendente depois de cada turno.
  const debidos = opciones.debidos?.length
    ? await db
        .select()
        .from(schema.message)
        .where(
          scoped(
            schema.message.organizationId,
            organizationId,
            and(
              eq(schema.message.conversationId, conversationId),
              eq(schema.message.direction, "in"),
              inArray(schema.message.id, [...opciones.debidos])
            )
          )
        )
    : [];
  const vigentes = debidosVigentes(recientes, debidos);
  const history = ordenarParaElTurno(recientes, vigentes);
  const lastInbound = [...history].reverse().find((m) => m.direction === "in");
  if (!lastInbound) return;
  const leido: TurnoLeido = {
    vistos: history.filter((m) => m.direction === "in").map((m) => m.id),
  };

  // Uma pessoa respondeu pela caixa de entrada antes de este turno começar:
  // o que o provocou já está atendido. Só no caminho do coalesce (o que traz
  // os pendentes); o Laboratório não tem quem responda à mão.
  if (opciones.debidos && !vigentes.length && atendidoPorPersona(recientes)) {
    return leido;
  }

  // Janela fechada: o agente JAMAIS envia texto livre → handoff 'ventana'.
  if (
    !conversation.isTest &&
    !isWindowOpen(
      conversation.lastInboundAt,
      new Date(),
      windowMsFor(conversation.channel)
    )
  ) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return leido;
  }

  // Padrão de reserva ANTES do LLM (FR-022). Avisa e transfere, na mesma
  // ordem do caminho do modelo (`farewell` e depois handoff): calar diante de
  // quem pede uma pessoa se lê como se o bot tivesse deixado de responder.
  if (lastInbound.text && matchesHandoffIntent(lastInbound.text)) {
    await acknowledgeHandoff(conversation);
    await applyHandoff(conversationId, organizationId, "cliente");
    return leido;
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const agenda = agendaEnabled();

  /**
   * 015 — Os horários vigentes, com seu instante exato.
   *
   * `book_slot` exige o `startUtc` e `findOffered` compara por epoch, sem
   * tolerância. Mas ao modelo só chegavam o prompt e o histórico de
   * TEXTO, onde estão os rótulos que o cliente leu — «seg 7 set, 11:00» —
   * sem ano, sem fuso e sem a data de hoje. Com isso, acertar o instante era
   * questão de sorte: a recusa caía sempre em `slot_not_offered`, cujo
   * texto é fixo, e a conversa ficava em loop repetindo a lista.
   *
   * É um furo de INTEGRAÇÃO: os testes de contrato passam porque
   * injetam o ISO correto, que é justamente o que o modelo não tinha.
   *
   * Sem oferta vigente nada é acrescentado, então o modelo continua obrigado a
   * ofertar antes de reservar. Entrega-se o catálogo COMPLETO, não só os
   * três que foram mostrados: se o cliente pedir outro dia, esse horário já
   * estava registrado como ofertado e agora o modelo também o conhece.
   *
   * Reportado por @Diony7004 em #50, com o diagnóstico já feito.
   */
  const ofertas = agenda ? await getOffers(organizationId, conversationId) : [];
  const mapaDeHuecos = mapaDeHuecosParaModelo(ofertas);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({ profile, kb, stages, agenda }),
    },
    ...history
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content: m.text!,
      })),
    /**
     * É colocado NO FINAL, depois do histórico: é o estado de AGORA, e pô-lo
     * antes o deixaria enterrado sob a conversa assim que esta crescesse.
     */
    ...(mapaDeHuecos
      ? [{ role: "system" as const, content: mapaDeHuecos }]
      : []),
    // 029 — O último que o modelo lê: responder com o JSON da ação.
    { role: "system", content: TURN_FORMAT_REMINDER },
  ];

  const result = await chatJson(agentActionSchema(agenda), messages, {
    organizationId,
  });
  if (!result.ok) {
    if (result.error === "not_configured") return leido;
    // Falha persistente do provedor ou saída impossível → escalar (FR-022).
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    await applyHandoff(conversationId, organizationId, "error");
    return leido;
  }

  let action: AgentActionType = result.data;

  // 015 — Agenda. Uma falha do motor degrada o turno (o agente responde sem
  // agendar), nunca o derruba: ficar calado é pior do que não agendar.
  if (action.action === "offer_slots" || action.action === "book_slot") {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      try {
        const turn =
          action.action === "offer_slots"
            ? await offerSlots({
                organizationId,
                conversationId,
                intro: action.reply,
              })
            : await bookSlot({
                organizationId,
                conversationId,
                startUtc: action.startUtc,
                confirmation: action.reply,
              });
        await deliverReply(conversation, turn.text);
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return leido;
      } catch (err) {
        console.error(`[agente] el motor de agenda falló: ${err}`);
        action = degradeAction(action);
      }
    }
  }

  if (action.action === "move_stage") {
    const stage = resolveStage(action.stage, stages);
    if (!stage) {
      action = degradeAction(action);
    } else {
      await moveLeadToStage(organizationId, conversation.contactId, stage.id);
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      });
      if (action.reply) {
        await deliverReply(conversation, action.reply);
      }
      return leido;
    }
  }

  switch (action.action) {
    case "none":
      return leido;
    case "reply":
      await deliverReply(conversation, action.text);
      return leido;
    case "update_lead": {
      await appendLeadNote(organizationId, conversation.contactId, action.note);
      if (action.reply) await deliverReply(conversation, action.reply);
      return leido;
    }
    case "handoff": {
      if (action.farewell) {
        await deliverReply(conversation, action.farewell);
      }
      await applyHandoff(conversationId, organizationId, "modelo");
      return leido;
    }
  }
  return leido;
}

type Conversation = typeof schema.conversation.$inferSelect;

/** Entrega a resposta: envio real ou persistência sandbox (is_test). */
async function deliverReply(
  conversation: Conversation,
  text: string
): Promise<void> {
  if (conversation.isTest) {
    await persistTestOutbound(conversation, text);
    return;
  }
  try {
    await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
    });
  } catch (err) {
    if (err instanceof SendError && err.code === "window_closed") {
      await applyHandoff(conversation.id, conversation.organizationId, "ventana");
      return;
    }
    // 022 — O canal não aceita mais mensagens até o cliente escrever
    // (o limite do TikTok). Não se transfere: deixaria a IA pausada para sempre
    // por algo que se resolve sozinho com a próxima mensagem do cliente.
    if (err instanceof SendError && err.code === "message_limit") {
      console.warn(
        `[agente] ${conversation.id}: ${err.message}. No se envía y la IA sigue activa.`
      );
      return;
    }
    throw err;
  }
}

/**
 * FR-022 — O aviso do padrão de reserva, antes de transferir.
 *
 * Sai por `deliverReply`, o mesmo caminho do `farewell` do modelo, de modo
 * que herda suas garantias: uma conversa do Laboratório a persiste sem
 * tocar a API, e com a janela de 24 h fechada não sai texto livre (o turno
 * já transferiu por `ventana` antes de chegar aqui, e o emissor a rejeitaria
 * do mesmo jeito). Também não se repete se o turno voltar a rodar: a transferência deixa
 * `handoffAt` preenchido e o turno seguinte se cala na primeira verificação,
 * igual ao que acontece após o `farewell`.
 *
 * A única mudança em relação a esse caminho: se o envio falhar, a transferência
 * se aplica MESMO ASSIM. Quem pediu uma pessoa precisa chegar a uma, mesmo que o
 * aviso não tenha saído; deixá-lo com a IA ligada seria pior que o silêncio.
 */
async function acknowledgeHandoff(conversation: Conversation): Promise<void> {
  try {
    await deliverReply(conversation, HANDOFF_BACKUP_ACK);
  } catch (err) {
    console.error(
      `[agente] el acuse del traspaso no salió en ${conversation.id}; se traspasa igual:`,
      err
    );
  }
}

/** Mensagem de saída do sandbox: é persistida, JAMAIS toca a API (FR-031). */
async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<void> {
  const db = getDb();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));
}

export async function applyHandoff(
  conversationId: string,
  organizationId: string,
  reason: "cliente" | "modelo" | "error" | "ventana"
): Promise<void> {
  const db = getDb();
  const updated = await db
    .update(schema.conversation)
    .set({ handoffAt: new Date(), handoffReason: reason, updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversationId))
    .returning();
  if (!updated[0]) return;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: { id: conversationId, handoffReason: reason },
    },
  });
}

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const leadId = rows[0]?.id;
  if (!leadId) return;

  // Pela porta única: o agente move cartões como o dono, e esse movimento
  // precisa ficar registrado, senão o funil mentiria sobre
  // quem fez avançar cada lead.
  await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
    // O agente não classifica perdas: se a etapa de destino dele acabar sendo a
    // perdida, a porta o rejeita e o lead fica onde está — melhor isso
    // do que um motivo inventado.
  });
}

async function appendLeadNote(
  organizationId: string,
  contactId: string,
  note: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.contact.id, notes: schema.contact.notes })
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);
  const contact = rows[0];
  if (!contact) return;
  const stamped = `[IA] ${note}`;
  await db
    .update(schema.contact)
    .set({
      notes: contact.notes ? `${contact.notes}\n${stamped}` : stamped,
      updatedAt: new Date(),
    })
    .where(eq(schema.contact.id, contact.id));
}
