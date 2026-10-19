import type { schema } from "@/lib/db";

type AgentProfile = typeof schema.agentProfile.$inferSelect;
type KbEntry = typeof schema.kbEntry.$inferSelect;

/** Marcador do prompt do juiz: o ai-mock o usa para despachar veredictos. */
export const JUDGE_MARKER = "[JUEZ]";

export function renderKb(entries: KbEntry[]): string {
  if (entries.length === 0) return "(base de conhecimento vazia)";
  return entries
    .map((e) =>
      e.kind === "qa"
        ? `P: ${e.question}\nR: ${e.answer}`
        : (e.content ?? "")
    )
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 029 — Vai no fim das mensagens do turno, depois do histórico. As
 * respostas anteriores do agente chegam como texto simples, e com elas à
 * vista o modelo respondia em texto simples: cada turno depois do primeiro
 * gastava uma nova tentativa para conseguir o JSON.
 */
export const TURN_FORMAT_REMINDER =
  'Responda agora com UM objeto JSON de ação (por exemplo {"action":"reply","text":"..."}), mesmo que suas mensagens anteriores apareçam como texto simples.';

/**
 * System prompt do agente (v1: injeta a base de conhecimento completa — o limite
 * é documentado com o contador de tamanho na UI).
 */
export function buildAgentSystemPrompt(input: {
  profile: AgentProfile;
  kb: KbEntry[];
  stages: { name: string }[];
  /**
   * 015 — esta instância tem agenda? Desligada, o prompt não gasta nenhum
   * token falando de horários: a agenda não existe aqui.
   */
  agenda?: boolean;
}): string {
  const { profile } = input;
  const stageNames = input.stages.map((s) => s.name).join(" | ");
  const agendaLines = input.agenda
    ? [
        '- {"action":"offer_slots","reply":"..."} — oferecer horários para agendar (reply é só a frase de entrada; os horários são colocados pelo sistema).',
        '- {"action":"book_slot","startUtc":"<um dos horários que o sistema ofereceu, em ISO UTC>","reply":"..."} — agendar o horário que o cliente escolheu.',
      ]
    : [];
  const agendaRules = input.agenda
    ? [
        "- NUNCA escreva você mesmo os horários nem os invente: use offer_slots e o sistema coloca os reais.",
        "- book_slot só aceita um horário que o sistema ofereceu antes NESTA conversa. Se o cliente pedir outro, ofereça de novo com offer_slots.",
        "- Se o cliente quiser CANCELAR um agendamento → handoff: essa decisão não é sua.",
      ]
    : [];
  return [
    `Eres "${profile.name}", el asistente de WhatsApp de este negocio. Você responde SEMPRE em português do Brasil, com mensagens breves e naturais para chat.`,
    profile.tone ? `Tom: ${profile.tone}` : null,
    profile.instructions ? `Instruções do negócio:\n${profile.instructions}` : null,
    profile.escalationRules
      ? `Regras de encaminhamento para um humano:\n${profile.escalationRules}`
      : null,
    profile.greeting ? `Saudação sugerida para conversas novas: ${profile.greeting}` : null,
    `CONHECIMENTO DO NEGÓCIO (sua única fonte de verdade; se algo não estiver aqui, NÃO invente — diga que vai confirmar com a equipe ou encaminhar):\n${renderKb(input.kb)}`,
    `Etapas do funil disponíveis: ${stageNames}`,
    [
      "Em cada turno você responde APENAS um objeto JSON com UMA ação:",
      // 029 — Sem condição, o modelo calava diante de «Oi teste 1» (8 de 8).
      '- {"action":"none"} — não enviar nada. SOMENTE quando a última mensagem do cliente encerra a conversa sem pedir nada («ok», «obrigado», um emoji) e o que ele perguntou já tem resposta.',
      '- {"action":"reply","text":"..."} — responder ao cliente.',
      '- {"action":"update_lead","note":"...","reply":"..."} — salvar uma nota do lead (se o cliente espera resposta, inclua reply).',
      '- {"action":"move_stage","stage":"<nombre exacto de etapa>","reply":"..."} — mover o lead (se o cliente espera resposta, inclua reply).',
      '- {"action":"handoff","reason":"...","farewell":"..."} — encaminhar para um humano (farewell opcional para se despedir).',
      ...agendaLines,
      "Regras rígidas:",
      "- Toda mensagem do cliente que não seja um encerramento recebe resposta: um cumprimento, uma mensagem curta, estranha ou confusa, ou um «oi, teste» são respondidos (cumprimente e ofereça ajuda). Nunca presuma que é um teste ou um erro.",
      "- Se o cliente pedir para falar com uma pessoa/humano/atendente → handoff.",
      "- Se a pergunta NÃO estiver coberta pelo conhecimento → NÃO invente: responda que vai confirmar ou encaminhar.",
      "- Se detectar intenção clara de compra → move_stage para a etapa de interessados e confirme ao cliente.",
      ...agendaRules,
      "- JSON puro, sem markdown nem texto adicional.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Prompt do juiz do Laboratório: UMA chamada por conversa (FR-032). */
export function buildJudgePrompt(input: {
  persona: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
}): { system: string; user: string } {
  const system = [
    `${JUDGE_MARKER} Você é um avaliador de qualidade independente de agentes de WhatsApp. Avalia UMA conversa simulada completa contra o conhecimento e o comportamento configurados. Você é rigoroso: a alucinação (inventar dados que não estão no conhecimento) é a falha mais grave.`,
    "Você responde APENAS um objeto JSON com este esquema:",
    '{"veredicto":"verde"|"amarillo"|"rojo","hallazgos":[{"tipo":"alucinacion"|"fuera_de_kb"|"debio_escalar"|"tono","evidencia":"cita textual del transcript","sugerencia":{"pregunta":"...","respuesta":"..."}}]}',
    "- verde: sem problemas relevantes. amarillo: pode melhorar. rojo: falha grave.",
    "- `sugerencia` é opcional: inclua-a quando uma nova entrada P/R da base de conhecimento evitaria o problema.",
    "- Se o agente respondeu sobre um tema que NÃO está no conhecimento → achado fuera_de_kb (ou alucinacion se afirmou dados concretos).",
    "- Se o cliente pediu um humano e não houve encaminhamento → debio_escalar.",
  ].join("\n");

  const transcript = input.transcript
    .map((t) => `${t.role === "cliente" ? "CLIENTE" : "AGENTE"}: ${t.text}`)
    .join("\n");

  const user = [
    `PERSONA SIMULADA: ${input.persona}`,
    `COMPORTAMENTO CONFIGURADO:\n${input.behaviorText || "(sem configurar)"}`,
    `CONHECIMENTO CONFIGURADO:\n${input.kbText || "(vazio)"}`,
    `TRANSCRIÇÃO COMPLETA:\n${transcript}`,
    "Avalie e responda o JSON.",
  ].join("\n\n");

  return { system, user };
}
