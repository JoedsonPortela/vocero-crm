/**
 * 025 — A ordem em que o agente incluído lê a conversa quando o
 * cliente escreveu enquanto pensava. Puras: não tocam o banco.
 *
 * Adaptação de `src/server/ai/orden-turno.ts` do Vocero Cloud. Lá, os pendentes
 * vêm do despacho; aqui, da entrada do coalesce de `pipeline.ts`.
 */

type Mensaje = { id: string; direction: "in" | "out"; createdAt: Date };

/**
 * Pura: o histórico na ordem em que o modelo deve lê-lo.
 *
 * Pela hora de chegada, o que o cliente escreveu enquanto o agente pensava
 * fica ANTES da resposta que saiu desse turno: usuário, usuário,
 * assistente. Lido assim, o modelo vê uma conversa que termina na sua
 * própria resposta e dá por respondida uma mensagem que nunca leu.
 *
 * `debidos` são as mensagens recebidas que este turno deve atender. Vão para o fim
 * junto com o que chegou depois da última resposta, na sua ordem; o resto
 * fica como estava. Sem `debidos` nada se move: o Laboratório e o
 * turno normal leem o histórico igual de sempre.
 */
export function ordenarParaElTurno<T extends Mensaje>(
  historial: readonly T[],
  debidos: readonly T[]
): T[] {
  if (!debidos.length) return [...historial];

  const ultimaSalida = historial.reduce(
    (idx, m, i) => (m.direction === "out" ? i : idx),
    -1
  );
  const sinAtender = new Map<string, T>();
  for (const m of debidos) {
    if (m.direction === "in") sinAtender.set(m.id, m);
  }
  historial.forEach((m, i) => {
    if (i > ultimaSalida && m.direction === "in") sinAtender.set(m.id, m);
  });

  const cola = [...sinAtender.values()].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );
  return [...historial.filter((m) => !sinAtender.has(m.id)), ...cola];
}

/**
 * Pura: do que está pendente, o que nenhuma PESSOA já respondeu.
 *
 * Uma pendente continua pendente mesmo que depois venha uma resposta do agente
 * (não a tinha lido). Se o que vem depois é uma saída de uma pessoa,
 * essa mensagem já teve quem a atendesse: movê-la para o fim seria fazer com que o
 * agente respondesse por cima.
 *
 * Decide-se pela posição no histórico, que vem ordenado pelo Postgres;
 * a hora só desempata uma pendente tão antiga que já não cabe nele.
 */
export function debidosVigentes<T extends Mensaje & { aiGenerated: boolean }>(
  historial: readonly T[],
  debidos: readonly T[]
): T[] {
  const ultimaHumana = historial.reduce(
    (idx, m, i) => (m.direction === "out" && !m.aiGenerated ? i : idx),
    -1
  );
  const humana = historial[ultimaHumana];
  if (!humana) return [...debidos];

  const posicion = new Map(historial.map((m, i) => [m.id, i]));
  return debidos.filter((m) => {
    const i = posicion.get(m.id);
    return i === undefined
      ? m.createdAt.getTime() > humana.createdAt.getTime()
      : i > ultimaHumana;
  });
}

/**
 * Pura: o que aconteceu por último na conversa foi uma PESSOA ter respondido?
 *
 * Entra uma mensagem e, antes de vencer a janela de agrupamento, o operador
 * responde pela caixa de entrada. Essa mensagem já está atendida: um turno do agente
 * seria responder por cima. Com o despacho, isso deixa a rajada vazia
 * e o despacho é descartado.
 */
export function atendidoPorPersona(
  historial: readonly { direction: "in" | "out"; aiGenerated: boolean }[]
): boolean {
  const ultimaHumana = historial.reduce(
    (idx, m, i) => (m.direction === "out" && !m.aiGenerated ? i : idx),
    -1
  );
  if (ultimaHumana === -1) return false;
  return !historial.some((m, i) => i > ultimaHumana && m.direction === "in");
}

/**
 * Pura: é preciso outro turno?
 *
 * `anotados` é o que entrou enquanto o turno corria; `vistos`, as
 * mensagens recebidas que esse turno chegou a ler (`undefined` se não chegou a abrir o histórico:
 * falhou ou parou antes). O que entrou e o turno já leu está atendido: outro
 * turno seria responder duas vezes. O que não leu continua pendente.
 */
export function quedanDebidos(
  anotados: ReadonlySet<string>,
  vistos: readonly string[] | undefined
): string[] {
  if (!vistos) return [...anotados];
  const leidos = new Set(vistos);
  return [...anotados].filter((id) => !leidos.has(id));
}
