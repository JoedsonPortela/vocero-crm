import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HANDOFF_BACKUP_ACK } from "@/server/ai/handoff";

/**
 * FR-022 — Quando o padrão de contingência detecta que o cliente pede uma
 * pessoa, o turno AVISA antes de transferir.
 *
 * Antes chamava `applyHandoff` e saía sem enviar nada: a transferência acontecia
 * por dentro, mas do lado do WhatsApp quem tinha pedido um humano ficava
 * sem resposta. O caminho do modelo nunca teve essa lacuna: despede-se com
 * `farewell` e depois transfere. Estes testes fixam que os dois caminhos saem pelo
 * MESMO emissor e na mesma ordem, e que o aviso herda suas garantias: sandbox,
 * janela e não se repetir.
 *
 * Encontrou-o @fondeur27-09-73 no PR #62, porque o Laboratório marcava em
 * vermelho «pede um humano» com a escalada bem feita: o juiz só vê mensagens,
 * e não havia nenhuma.
 */

/** Ordem observável: o que foi enviado e quando se transferiu. */
const eventos: string[] = [];

const sendText = vi.fn();
const graphRequest = vi.fn();
const chatJson = vi.fn();

vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});

vi.mock("@/lib/ai", () => ({ chatJson }));

// #85 — a resolução do provedor olha primeiro a linha de Ajustes → IA. Sem
// linha cai no ambiente (`OPENROUTER_API_TOKEN`, abaixo), sem tocar a fila de
// selects do BD simulado.
vi.mock("@/server/ai/credentials", () => ({
  getAiCredentialPublic: async () => null,
  getAiCredentialSecret: async () => null,
}));

// BD simulado: fila de resultados de select + capturas de insert/update.
const selectQueue: unknown[][] = [];
const inserts: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        if (values.direction === "out") eventos.push(`persistido:${values.text}`);
        const chain = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve([values]).then(resolve),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        if (values.handoffReason) eventos.push(`handoff:${values.handoffReason}`);
        return {
          where: () => {
            const chain = {
              returning: () => Promise.resolve([{ id: "cv_1" }]),
              then: (resolve: (v: unknown) => void) =>
                Promise.resolve([{ id: "cv_1" }]).then(resolve),
            };
            return chain;
          },
        };
      },
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          { get: (_t2, col) => `${String(tableName)}.${String(col)}` }
        ),
    }
  ),
}));

const HORA = 60 * 60 * 1000;

function conversacion(extra: Record<string, unknown> = {}) {
  return {
    id: "cv_1",
    organizationId: "org_1",
    contactId: "ct_1",
    channel: "whatsapp",
    isTest: false,
    aiEnabled: true,
    handoffAt: null,
    handoffReason: null,
    lastInboundAt: new Date(),
    ...extra,
  };
}

const perfil = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Asistente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

function historial(text: string) {
  return [{ id: "msg_1", direction: "in", text, createdAt: new Date() }];
}

/** Um turno em que o cliente escreve `text`: conversa, perfil, histórico. */
function turno(text: string, conv = conversacion()) {
  selectQueue.push([conv], [perfil], historial(text));
}

/**
 * O pipeline arrasta meio servidor (envio, canais, agenda). Importá-lo
 * dentro do primeiro teste consumia seu timeout de 5 s numa execução
 * carregada, e o teste que expirava seguia rodando em segundo plano e
 * consumia a fila de selects do seguinte. Carrega-se UMA vez, com folga.
 */
let runAgentTurn: (conversationId: string) => Promise<unknown>;
let SendError: typeof import("@/server/inbox/send").SendError;

async function correrTurno() {
  await runAgentTurn("cv_1");
}

describe("acuse del patrón de respaldo antes de traspasar (FR-022)", () => {
  beforeAll(async () => {
    ({ runAgentTurn } = await import("@/server/ai/pipeline"));
    ({ SendError } = await import("@/server/inbox/send"));
  }, 60_000);

  beforeEach(() => {
    eventos.length = 0;
    selectQueue.length = 0;
    inserts.length = 0;
    updates.length = 0;
    sendText.mockReset();
    sendText.mockImplementation(async (input: { text: string }) => {
      eventos.push(`enviado:${input.text}`);
      return { messageId: "msg_out" };
    });
    graphRequest.mockReset();
    chatJson.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("el cliente que pide un humano recibe el acuse, y DESPUÉS se traspasa", async () => {
    turno("quiero hablar con un humano");
    await correrTurno();

    expect(eventos).toEqual([`enviado:${HANDOFF_BACKUP_ACK}`, "handoff:cliente"]);
    // Pelo emissor de sempre: o mesmo que usa o `farewell` do modelo,
    // com seu guard de sandbox e de janela dentro.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      conversationId: "cv_1",
      organizationId: "org_1",
      text: HANDOFF_BACKUP_ACK,
      aiGenerated: true,
    });
    // O respaldo continua cortando ANTES do modelo.
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("en el Laboratorio el acuse queda en la conversación y JAMÁS toca la API", async () => {
    turno("quiero hablar con un humano", conversacion({ isTest: true }));
    await correrTurno();

    expect(sendText).not.toHaveBeenCalled();
    expect(graphRequest).not.toHaveBeenCalled();
    const saliente = inserts.find((v) => v.direction === "out");
    expect(saliente).toMatchObject({
      text: HANDOFF_BACKUP_ACK,
      aiGenerated: true,
      origin: "ai",
    });
    // E o juiz do Laboratório já tem o que ler antes do corte do roteiro.
    expect(eventos).toEqual([`persistido:${HANDOFF_BACKUP_ACK}`, "handoff:cliente"]);
  });

  it("si el acuse no sale, el traspaso se aplica IGUAL (y el turno no revienta)", async () => {
    sendText.mockRejectedValueOnce(
      new SendError("meta_unavailable", "Meta no está disponible ahora")
    );
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    turno("me pasas a un asesor");

    await expect(correrTurno()).resolves.toBeUndefined();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.handoffReason === "cliente")).toBe(true);
    consola.mockRestore();
  });

  it("con la ventana de 24 h cerrada no hay texto libre: se traspasa por `ventana`", async () => {
    turno(
      "quiero hablar con un humano",
      conversacion({ lastInboundAt: new Date(Date.now() - 25 * HORA) })
    );
    await correrTurno();

    expect(sendText).not.toHaveBeenCalled();
    expect(eventos).toEqual(["handoff:ventana"]);
  });

  it("un turno que vuelve a correr tras el traspaso NO repite el acuse", async () => {
    // Primeiro turno: aviso + transferência.
    turno("quiero hablar con un humano");
    await correrTurno();
    // O que chegar nesse meio tempo re-enfileira um turno; esse turno lê a
    // conversa JÁ transferida. A última mensagem recebida segue sendo a mesma
    // frase, então se o silêncio não enviasse, o aviso sairia duas vezes.
    turno(
      "quiero hablar con un humano",
      conversacion({ handoffAt: new Date(), handoffReason: "cliente" })
    );
    await correrTurno();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(eventos).toEqual([`enviado:${HANDOFF_BACKUP_ACK}`, "handoff:cliente"]);
  });

  it("es el mismo emisor y el mismo orden que el `farewell` del camino del modelo", async () => {
    // Um texto que o padrão NÃO pega: decide o modelo.
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "handoff", reason: "cliente", farewell: "Te paso con el equipo." },
      raw: "{}",
    });
    selectQueue.push(
      [conversacion()],
      [perfil],
      historial("esto ya me cansó"),
      [], // kb
      [] // etapas
    );
    await correrTurno();

    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      conversationId: "cv_1",
      organizationId: "org_1",
      text: "Te paso con el equipo.",
      aiGenerated: true,
    });
    expect(eventos).toEqual(["enviado:Te paso con el equipo.", "handoff:modelo"]);
  });
});

/**
 * 022 — O canal já não admite mais mensagens até que o cliente escreva (o
 * teto do TikTok). Se o agente bate nele, fica calado: uma transferência deixaria a IA
 * em pausa para sempre por algo que se resolve sozinho com a próxima mensagem.
 */
describe("el tope de mensajes del canal no traspasa (022)", () => {
  beforeEach(() => {
    eventos.length = 0;
    selectQueue.length = 0;
    inserts.length = 0;
    updates.length = 0;
    sendText.mockReset();
    chatJson.mockReset();
    chatJson.mockResolvedValue({ ok: true, data: { action: "reply", text: "Claro, con gusto" } });
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("message_limit al enviar: no se traspasa y el turno no revienta", async () => {
    sendText.mockRejectedValueOnce(
      new SendError("message_limit", "TikTok solo permite 10 mensajes")
    );
    // conversa, perfil, histórico, conhecimento, etapas
    selectQueue.push(
      [conversacion({ channel: "tiktok" })],
      [perfil],
      historial("¿siguen ahí?"),
      [],
      []
    );
    await expect(runAgentTurn("cv_1")).resolves.toBeDefined();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(eventos.filter((e) => e.startsWith("handoff:"))).toEqual([]);
    expect(updates.some((u) => "handoffReason" in u || "handoffAt" in u)).toBe(false);
  });

  it("la ventana cerrada sí sigue traspasando, como siempre", async () => {
    sendText.mockRejectedValueOnce(new SendError("window_closed", "cerrada"));
    selectQueue.push([conversacion()], [perfil], historial("¿siguen ahí?"), [], []);
    await runAgentTurn("cv_1");
    expect(eventos).toContain("handoff:ventana");
  });
});
