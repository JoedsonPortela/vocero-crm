import { eq, inArray } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import { schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

/**
 * Negocio de demostración "Ferretería El Martillo" (FR-075).
 * Idempotente: borra los datos demo previos de la organización (scoped por
 * los teléfonos demo) y reinserta. El KB queda lleno EXCEPTO garantías y
 * devoluciones — hueco INTENCIONAL para que el Laboratorio encuentre algo
 * real en la primera corrida.
 */

type Db = ReturnType<typeof getDb>;

const HOURS = 60 * 60 * 1000;

const DEMO_CONTACTS: {
  phone: string;
  name: string;
  notes?: string;
  stage: string;
  thread: { dir: "in" | "out"; text: string; hoursAgo: number; ai?: boolean }[];
}[] = [
  {
    phone: "5215612340001",
    name: "María Fernanda López",
    stage: "Interessado",
    notes: "Remodela su cocina; busca herramienta eléctrica.",
    thread: [
      { dir: "in", text: "Oi, vocês têm furadeiras sem fio?", hoursAgo: 5 },
      { dir: "out", text: "Oi, María! Sim: temos a Truper 20V por $1,899 MXN e a DeWalt 20V MAX por $3,450 MXN, ambas com bateria incluída.", hoursAgo: 5, ai: true },
      { dir: "in", text: "A Truper vem com brocas?", hoursAgo: 4 },
      { dir: "out", text: "Vem com um jogo básico de 5 brocas para concreto e madeira. Se precisar de mais, o jogo de 30 peças está por $349 MXN.", hoursAgo: 4, ai: true },
      { dir: "in", text: "Perfeito, tenho interesse na Truper. Vocês me reservam?", hoursAgo: 3 },
    ],
  },
  {
    phone: "5215612340002",
    name: "Carlos Ramírez",
    stage: "Em conversa",
    thread: [
      { dir: "in", text: "Boa tarde, quanto custa o saco de cimento cinza?", hoursAgo: 8 },
      { dir: "out", text: "Oi, Carlos! O saco de 50 kg está por $245 MXN. Para 10 ou mais, cada um fica em $232 MXN.", hoursAgo: 8, ai: true },
      { dir: "in", text: "Preciso de 15 sacos, vocês entregam em Naucalpan?", hoursAgo: 7 },
      { dir: "out", text: "Sim, entregamos em toda a região. O frete é de $150 MXN e chega no mesmo dia se você confirmar antes das 13h. Total: 15 × $232 + $150 = $3,630 MXN.", hoursAgo: 7, ai: true },
    ],
  },
  {
    phone: "5215612340003",
    name: "Lupita Hernández",
    stage: "Cliente",
    notes: "Compra recurrente para su taller de carpintería.",
    thread: [
      { dir: "in", text: "Oi de novo, já acabou meu verniz 😅", hoursAgo: 30 },
      { dir: "out", text: "Oi, Lupita! Reservamos 2 litros do verniz marítimo que você sempre leva: $520 MXN. Mando junto com o seu pedido de lixas?", hoursAgo: 30, ai: true },
      { dir: "in", text: "Sim, por favor, junta tudo numa só entrega", hoursAgo: 29 },
      { dir: "out", text: "Pronto, sai hoje mesmo. Total: $780 MXN com as lixas. Obrigado pela compra!", hoursAgo: 29, ai: true },
    ],
  },
  {
    phone: "5215612340004",
    name: "Jorge Castillo",
    stage: "Novo",
    thread: [
      { dir: "in", text: "e aí, vocês têm tinta vinílica branca de 19 L?", hoursAgo: 2 },
      { dir: "out", text: "Oi, Jorge! Sim: o balde de 19 L de vinílica branca está por $1,150 MXN (rende ~90 m²). Quer fosca ou acetinada?", hoursAgo: 2, ai: true },
    ],
  },
  {
    phone: "5215612340005",
    name: "Ana Sofía Torres",
    stage: "Interessado",
    thread: [
      { dir: "in", text: "Oi, vi o anúncio de vocês. Trabalham com material elétrico?", hoursAgo: 12 },
      { dir: "out", text: "Oi, Ana! Sim: cabos, tomadas, interruptores e quadros de distribuição. Do que você precisa para o seu projeto?", hoursAgo: 12, ai: true },
      { dir: "in", text: "Preciso de 100 m de cabo bitola 12 e 10 tomadas duplas", hoursAgo: 11 },
      { dir: "out", text: "Orçamento: rolo de 100 m bitola 12 THW $1,890 MXN + 10 tomadas duplas Volteck a $35 cada = $2,240 MXN. Quer que eu separe?", hoursAgo: 11, ai: true },
      { dir: "in", text: "Deixa eu confirmar com o eletricista e te digo", hoursAgo: 10 },
    ],
  },
  {
    phone: "5215612340006",
    name: "Roberto Mendoza",
    stage: "Perdido",
    notes: "Buscaba precio de mayoreo que no podemos igualar.",
    thread: [
      { dir: "in", text: "Quanto está a tonelada de vergalhão 3/8?", hoursAgo: 96 },
      { dir: "out", text: "Oi, Roberto: a tonelada de vergalhão 3/8 está por $17,800 MXN. Para quando você precisa?", hoursAgo: 96, ai: true },
      { dir: "in", text: "Ah, não, em outro lugar me dão a 16", hoursAgo: 95 },
      { dir: "out", text: "Entendo. Esse preço não conseguimos igualar, mas se o seu fornecedor falhar, estamos aqui com entrega no mesmo dia. Boa sorte na obra!", hoursAgo: 95, ai: true },
    ],
  },
  {
    phone: "5215612340007",
    name: "Paty Domínguez",
    stage: "Em conversa",
    thread: [
      { dir: "in", text: "Oi, vocês têm impermeabilizante? A laje está vazando 😩", hoursAgo: 26 },
      { dir: "out", text: "Oi, Paty! Claro: o impermeabilizante acrílico 5 anos (balde 19 L) está por $1,680 MXN e cobre ~40 m². Quantos metros tem a sua laje?", hoursAgo: 26, ai: true },
      { dir: "in", text: "Uns 60 metros, será que dois me bastam?", hoursAgo: 25 },
    ],
  },
  {
    phone: "5215612340008",
    name: "Don Chuy Aguilar",
    stage: "Cliente",
    thread: [
      { dir: "in", text: "Moço, manda a lista de sempre para a turma", hoursAgo: 50 },
      { dir: "out", text: "Com prazer, Don Chuy! Seu pedido habitual: 5 sacos de cimento, 2 de argamassa, 1 rolo de arame recozido e 3 kg de prego. Total: $1,585 MXN. Mandamos para a obra da Av. Juárez?", hoursAgo: 50, ai: true },
      { dir: "in", text: "Tá bom, pode mandar. Paga na entrega, como sempre", hoursAgo: 49 },
      { dir: "out", text: "Perfeito, sai na caminhonete das 16h. Obrigado, Don Chuy!", hoursAgo: 49, ai: true },
    ],
  },
];

const DEMO_KB: { kind: "qa" | "block"; question?: string; answer?: string; content?: string }[] = [
  {
    kind: "block",
    content:
      "Ferragem El Martelo — ferragem familiar com 20 anos no bairro Centro. Vendemos ferramenta manual e elétrica, material de construção, tinta, encanamento e material elétrico. Atendemos público geral, mestres de obra e oficinas.",
  },
  { kind: "qa", question: "Qual é o horário?", answer: "Segunda a sábado das 8h às 19h e domingos das 9h às 14h." },
  { kind: "qa", question: "Onde vocês ficam?", answer: "Av. Hidalgo 245, bairro Centro. Há estacionamento gratuito para clientes na rua lateral." },
  { kind: "qa", question: "Fazem entregas em domicílio?", answer: "Sim: entrega no mesmo dia na região se você confirmar antes das 13h. Frete local $150 MXN; grátis em compras acima de $3,000 MXN." },
  { kind: "qa", question: "Quais formas de pagamento aceitam?", answer: "Dinheiro, cartão (crédito/débito), transferência SPEI e pagamento na entrega em pedidos locais." },
  { kind: "qa", question: "Emitem nota fiscal?", answer: "Sim, emitimos no mesmo dia. Envie sua constância de situação fiscal e o cupom de compra." },
  { kind: "qa", question: "Têm preço de atacado?", answer: "Sim: em cimento, argamassa e vergalhão há preço especial a partir de 10 unidades; em tinta, a partir de 5 baldes. Peça seu orçamento pelo WhatsApp." },
  { kind: "qa", question: "Quais marcas de ferramenta vocês trabalham?", answer: "Truper, Pretul, DeWalt, Makita e Ryobi em elétrica; Volteck e Condulac em material elétrico; Comex e Berel em tinta." },
  // LACUNA INTENCIONAL: nada sobre garantia nem devoluções (o Laboratório encontra).
];

export async function seedDemo(
  db: Db,
  organizationId: string
): Promise<{ contacts: number; kbEntries: number }> {
  const demoPhones = DEMO_CONTACTS.map((c) => c.phone);

  // --- Idempotencia: limpiar datos demo previos (orden inverso de FKs) ---
  const prevContacts = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(inArray(schema.contact.phone, demoPhones));
  const prevIds = prevContacts.map((c) => c.id);
  if (prevIds.length > 0) {
    const prevConvs = await db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(inArray(schema.conversation.contactId, prevIds));
    const convIds = prevConvs.map((c) => c.id);
    if (convIds.length > 0) {
      await db
        .delete(schema.message)
        .where(inArray(schema.message.conversationId, convIds));
      await db
        .delete(schema.conversation)
        .where(inArray(schema.conversation.id, convIds));
    }
    await db.delete(schema.lead).where(inArray(schema.lead.contactId, prevIds));
    await db.delete(schema.contact).where(inArray(schema.contact.id, prevIds));
  }
  // KB y corridas demo previas
  await db
    .delete(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId));
  await db
    .delete(schema.agentTestCase)
    .where(eq(schema.agentTestCase.organizationId, organizationId));
  await db
    .delete(schema.agentTestRun)
    .where(eq(schema.agentTestRun.organizationId, organizationId));

  // --- Etapas (por nombre) ---
  const stages = await db
    .select()
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId));
  const stageByName = new Map(stages.map((s) => [s.name, s.id]));
  const fallbackStage = stages[0]?.id;
  if (!fallbackStage) throw new Error("La organización no tiene etapas");

  // --- Contactos + conversaciones + mensajes + leads ---
  const now = Date.now();
  let position = 0;
  for (const demo of DEMO_CONTACTS) {
    const contactId = newId("contact");
    await db.insert(schema.contact).values({
      id: contactId,
      organizationId,
      phone: demo.phone,
      waIdentity: demo.phone,
      name: demo.name,
      notes: demo.notes ?? null,
    });

    const lastInbound = demo.thread
      .filter((t) => t.dir === "in")
      .reduce((min, t) => Math.min(min, t.hoursAgo), Infinity);
    const lastMessage = demo.thread.reduce(
      (min, t) => Math.min(min, t.hoursAgo),
      Infinity
    );

    const conversationId = newId("conversation");
    await db.insert(schema.conversation).values({
      id: conversationId,
      organizationId,
      contactId,
      lastInboundAt: new Date(now - lastInbound * HOURS),
      lastMessageAt: new Date(now - lastMessage * HOURS),
      unreadCount: demo.thread[demo.thread.length - 1]?.dir === "in" ? 1 : 0,
    });

    for (const msg of demo.thread) {
      const at = new Date(now - msg.hoursAgo * HOURS);
      await db.insert(schema.message).values({
        id: newId("message"),
        organizationId,
        conversationId,
        waMessageId: `wamid.demo.${newId("message")}`,
        direction: msg.dir,
        type: "text",
        text: msg.text,
        status: msg.dir === "in" ? "delivered" : "read",
        aiGenerated: msg.ai ?? false,
        origin: msg.ai ? "ai" : "operator",
        waTimestamp: at,
        createdAt: at,
      });
    }

    await db.insert(schema.lead).values({
      id: newId("lead"),
      organizationId,
      contactId,
      stageId: stageByName.get(demo.stage) ?? fallbackStage,
      position: position++,
      lastActivityAt: new Date(now - lastMessage * HOURS),
    });
  }

  // --- Knowledge base (con el hueco intencional) ---
  for (const entry of DEMO_KB) {
    await db.insert(schema.kbEntry).values({
      id: newId("kbEntry"),
      organizationId,
      kind: entry.kind,
      question: entry.question ?? null,
      answer: entry.answer ?? null,
      content: entry.content ?? null,
    });
  }

  // --- Comportamiento del agente de la demo ---
  await db
    .update(schema.agentProfile)
    .set({
      name: "Martillito",
      tone: "Cercano y práctico, de ferretería de confianza. Tutea al cliente.",
      instructions:
        "Ayuda a cotizar y cerrar ventas. Da precios en MXN solo si están en el conocimiento. Si piden mayoreo, menciona los mínimos. Nunca inventes existencias.",
      escalationRules:
        "Escala a un humano si piden factura con datos fiscales complejos, si hay una queja de producto dañado o si lo piden explícitamente.",
      greeting: "¡Hola! Soy Martillito, el asistente de Ferretería El Martillo 🔨",
      updatedAt: new Date(),
    })
    .where(eq(schema.agentProfile.organizationId, organizationId));

  // --- Corrida de Laboratorio de ejemplo (guardada, con el hueco encontrado) ---
  const runId = newId("testRun");
  await db.insert(schema.agentTestRun).values({
    id: runId,
    organizationId,
    status: "done",
    score: 83,
    startedAt: new Date(now - 24 * HOURS),
    finishedAt: new Date(now - 24 * HOURS + 3 * 60 * 1000),
  });
  const exampleCases: {
    persona: string;
    veredicto: "verde" | "amarillo" | "rojo";
    hallazgos: unknown[];
    transcript: { role: string; text: string }[];
  }[] = [
    {
      persona: "comprador_decidido",
      veredicto: "verde",
      hallazgos: [],
      transcript: [
        { role: "cliente", text: "¿Tienen taladros inalámbricos disponibles?" },
        { role: "agente", text: "¡Sí! Truper 20V en $1,899 MXN y DeWalt 20V MAX en $3,450 MXN." },
        { role: "cliente", text: "Me convence, lo compro. ¿Cómo pago?" },
        { role: "agente", text: "Aceptamos efectivo, tarjeta, SPEI o contra entrega. Te lo aparto ahora mismo." },
      ],
    },
    {
      persona: "pregunton_precios",
      veredicto: "verde",
      hallazgos: [],
      transcript: [
        { role: "cliente", text: "¿Qué precio tiene el martillo?" },
        { role: "agente", text: "Tenemos varios; el más pedido es el Truper de uña. ¿Te confirmo precio y existencia con el equipo?" },
      ],
    },
    {
      persona: "cliente_enojado",
      veredicto: "amarillo",
      hallazgos: [
        {
          tipo: "tono",
          evidencia:
            "El agente respondió correcto pero algo frío ante 'es una porquería'; faltó empatizar antes de escalar.",
        },
      ],
      transcript: [
        { role: "cliente", text: "Compré una lijadora la semana pasada y ya no prende, es una porquería" },
        { role: "agente", text: "Lamento el problema. Paso tu caso a un compañero del equipo para resolverlo." },
      ],
    },
    {
      persona: "fuera_de_kb",
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
      transcript: [
        { role: "cliente", text: "¿Cuál es su política de garantías y devoluciones?" },
        { role: "agente", text: "Déjame confirmarlo con el equipo y te digo en un momento." },
      ],
    },
    {
      persona: "pide_humano",
      veredicto: "verde",
      hallazgos: [],
      transcript: [
        { role: "cliente", text: "Prefiero que me atienda una persona, quiero hablar con un humano" },
        { role: "agente", text: "(handoff: la conversación pasó a atención humana)" },
      ],
    },
    {
      persona: "errores_modismos",
      veredicto: "verde",
      hallazgos: [],
      transcript: [
        { role: "cliente", text: "ke onda, si benden pintura?" },
        { role: "agente", text: "¡Claro! Manejamos Comex y Berel. ¿Qué necesitas pintar?" },
      ],
    },
  ];
  for (const c of exampleCases) {
    await db.insert(schema.agentTestCase).values({
      id: newId("testCase"),
      organizationId,
      runId,
      persona: c.persona,
      status: "done",
      veredicto: c.veredicto,
      hallazgos: c.hallazgos,
      transcript: c.transcript,
    });
  }

  return { contacts: DEMO_CONTACTS.length, kbEntries: DEMO_KB.length };
}

/** true si la organización aún no tiene datos de dominio (para el botón). */
export async function isDomainEmpty(
  db: Db,
  organizationId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(eq(schema.contact.organizationId, organizationId))
    .limit(1);
  return rows.length === 0;
}
