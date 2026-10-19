import { JUDGE_MARKER } from "@/server/ai/prompts";
import { CABECERA_HUECOS } from "@/server/agenda/offers";

/**
 * Provedor LLM determinista para o self-test (contrato mocks.md).
 * Despacha pelo conteúdo da última mensagem `user` (ou do system se for o
 * juiz). JAMAIS é fallback em runtime: só responde se OPENROUTER_BASE_URL
 * aponta explicitamente para ele e o gate de mocks está ativo.
 */

type InMessage = { role: string; content: string };

/**
 * Sufixos da chave que o mock rejeita, com o código que daria o
 * provedor real: `-invalid` → 401 (chave recusada) e `-sin-saldo` → 402.
 * É o que permite exercitar a pausa de Configurações → IA no self-test sem
 * um provedor de verdade. Qualquer outra chave é aceita.
 */
export function aiMockAuthFailure(
  authorization: string | null
): { status: 401 | 402; body: { error: { message: string } } } | null {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token.endsWith("-invalid")) {
    return { status: 401, body: { error: { message: "Invalid API key (mock)" } } };
  }
  if (token.endsWith("-sin-saldo")) {
    return {
      status: 402,
      body: { error: { message: "Insufficient credits (mock)" } },
    };
  }
  return null;
}

/** A lista de `GET /v1/models` do mock: suficiente para «Buscar modelos». */
export function aiMockModels(): { id: string; name: string }[] {
  return [
    { id: "mock/agente", name: "Modelo de prueba (agente)" },
    { id: "mock/juez", name: "Modelo de prueba (juez)" },
  ];
}

/**
 * 025 — O que o roteiro precisa para testar o turno do agente incluído.
 *
 * `demoraMs` faz o modelo «pensar»: é o que deixa inserir uma mensagem com
 * o turno em curso. E guarda-se o que lhe foi perguntado, porque a resposta
 * sozinha não diz em que ORDEM leu a conversa — e essa ordem é justamente o que
 * decide se atende a mensagem que entrou enquanto pensava.
 */
type Peticion = { at: string; mensajes: InMessage[] };
type EstadoIa = { demoraMs: number; peticiones: Peticion[] };

const globalForIa = globalThis as unknown as { __voceroAiMock?: EstadoIa };

function estadoIa(): EstadoIa {
  globalForIa.__voceroAiMock ??= { demoraMs: 0, peticiones: [] };
  return globalForIa.__voceroAiMock;
}

/** Consulta ou configura o mock: `?demoraMs=3000`, `?reset=1`. */
export function aiMockEstado(params: URLSearchParams): EstadoIa {
  const e = estadoIa();
  const demoraMs = params.get("demoraMs");
  if (demoraMs !== null) {
    e.demoraMs = Math.min(Math.max(Number(demoraMs) || 0, 0), 60_000);
  }
  if (params.get("reset") === "1") e.peticiones = [];
  return e;
}

/**
 * Anota a requisição e espera o configurado. O juiz do Laboratório não se
 * anota nem se demora: o que se observa é a conversa com o cliente.
 */
export async function aiMockRegistrar(messages: InMessage[]): Promise<void> {
  if (messages.some((m) => m.role === "system" && m.content.includes(JUDGE_MARKER))) {
    return;
  }
  const e = estadoIa();
  // Sem o prompt de sistema: é longo, e o que se verifica é a conversa.
  e.peticiones.push({
    at: new Date().toISOString(),
    mensajes: messages.filter((m) => m.role !== "system"),
  });
  if (e.peticiones.length > 50) e.peticiones.shift();
  if (e.demoraMs > 0) await new Promise((r) => setTimeout(r, e.demoraMs));
}

export function aiMockCompletion(messages: InMessage[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // Juiz do Laboratório: veredito determinista por pessoa. Para fechar o
  // loop do self-test, a pessoa fora_de_kb passa a verde se o CONHECIMENTO
  // configurado já cobrir garantias/devoluções (sugestão aplicada).
  if (system.includes(JUDGE_MARKER)) {
    const kbSection =
      lastUser
        .split("CONOCIMIENTO CONFIGURADO:")[1]
        ?.split("TRANSCRIPT COMPLETO:")[0] ?? "";
    const kbCoversWarranty = /garant|devoluc/i.test(kbSection);
    if (lastUser.includes("fuera_de_kb") && !kbCoversWarranty) {
      return JSON.stringify({
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "fuera_de_kb",
            evidencia:
              "El cliente preguntó por garantías y devoluciones y el conocimiento no lo cubre.",
            sugerencia: {
              pregunta: "¿Cuál es la política de garantías y devoluciones?",
              respuesta:
                "Aceptamos devoluciones dentro de los 30 días con ticket de compra; la garantía depende del fabricante.",
            },
          },
        ],
      });
    }
    return JSON.stringify({ veredicto: "verde", hallazgos: [] });
  }

  const text = lastUser.toLowerCase();

  /**
   * 015 — A agenda, exercitando o caminho REAL.
   *
   * O mock reserva copiando o `startUtc` do mapa de horários, igual ao que tem
   * que fazer um modelo de verdade. Se esse mapa deixar de chegar, aqui não há de
   * onde tirar o instante e a reserva falha — que é exatamente a falha que se viveu
   * em produção (#50), em vez de um teste que a simula.
   *
   * Procuram-se TODAS as mensagens `system`, não só a primeira: o mapa vai ao
   * final, depois do histórico.
   */
  const huecos = messages
    .filter((m) => m.role === "system" && m.content.includes(CABECERA_HUECOS))
    .flatMap((m) => m.content.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? []);

  /**
   * Só oferece horários se o prompt lhe MOSTROU `offer_slots`, como um modelo
   * real. Com a agenda desligada o prompt não a traz (nem o esquema do turno
   * a aceita), e o mock a respondia mesmo assim: a conversa acabava em
   * "Erro do provedor de IA", algo que em produção não acontece (R11).
   */
  const agendaEnseñada = messages.some(
    (m) => m.role === "system" && m.content.includes('"action":"offer_slots"')
  );
  const quiereCita = /cita|agendar|agenda|horario|reserv/.test(text);
  if (agendaEnseñada && quiereCita && huecos.length === 0) {
    return JSON.stringify({
      action: "offer_slots",
      reply: "Claro, tengo estos horarios:",
    });
  }
  const eligeUno = /primero|segundo|ese|esa|confirmo|quiero|me sirve/.test(text);
  if (huecos.length > 0 && eligeUno) {
    return JSON.stringify({
      action: "book_slot",
      startUtc: huecos[0],
      reply: "¡Listo! Te agendé.",
    });
  }

  // Persona pede_humano (o regex de reserva captura a frase canônica; esta
  // rama cobre variantes que chegam ao modelo).
  if (text.includes("humano") || text.includes("asesor")) {
    return JSON.stringify({ action: "handoff", reason: "cliente" });
  }

  // Intenção de compra → mover para Interessado.
  if (
    text.includes("lo compro") ||
    text.includes("quiero comprar") ||
    text.includes("me lo llevo")
  ) {
    return JSON.stringify({
      action: "move_stage",
      stage: "Interessado",
      reply: "¡Excelente! Te aparto el producto y un compañero te confirma el pago.",
    });
  }

  const eco = lastUser.slice(0, 80);
  return JSON.stringify({
    action: "reply",
    text: `Respuesta de prueba sobre: ${eco}`,
  });
}
