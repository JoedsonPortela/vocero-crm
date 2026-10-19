/**
 * Self-test E2E de comportamento — 024: texto do agente nas redes e janela
 * de atendimento humano.
 *
 * Conduz o app real com os simuladores: envia mensagens pelo webhook como
 * faria o Zernio (com a data necessária para envelhecer a janela),
 * responde como cérebro (`/api/bot/messages`) e como pessoa (a bandeja), e
 * confere o que saiu para cada plataforma e o que ficou na conversa.
 *
 * Uso:
 *   1) app rodando (`next dev`) sobre um banco migrado, SEM
 *      BRAIN_DISPATCH_URL, com CHANNELS=whatsapp,instagram,messenger,tiktok,
 *      WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock, ZERNIO_BASE_URL →
 *      zernio-mock, OPENROUTER_BASE_URL → ai-mock com OPENROUTER_API_TOKEN e
 *      OPENROUTER_MODEL, BOT_API_KEY e AGENT_COALESCE_MS curto (1500).
 *   2) node --env-file=.env scripts/e2e-ventana-social.mjs
 *
 * Sai com código 1 se alguma verificação falhar. Roteiro: tests/e2e/us-ventana-social.md.
 */
import { createHmac } from "node:crypto";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN ?? "";
const BOT_KEY = process.env.BOT_API_KEY ?? "";
const COALESCE = Number(process.env.AGENT_COALESCE_MS ?? 6000);
const CHANNELS = (process.env.CHANNELS ?? "").split(",").map((c) => c.trim());
const RUN = Date.now().toString(36);
const MARCA = `#${RUN}`;
const SECRET = "secreto-del-webhook-de-zernio";
const LLAVE = "sk_llave-de-zernio-ventana";
const PN = "PN-E2E-1";
const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const CUENTA = { ig: `ig-vs-${RUN}`, fb: `fb-vs-${RUN}`, tt: `tt-vs-${RUN}` };
const PLATAFORMA = { ig: "instagram", fb: "facebook", tt: "tiktok" };
const CANAL = { ig: "instagram", fb: "messenger", tt: "tiktok" };

// O que uma IA escreve: formato de WhatsApp e Markdown misturados.
const CON_FORMATO = (m) =>
  `*Hola* ${m}\n**Horario:** de _9 a 6_\n- Martillos\n- ~Clavos~ agotados\nMira el [catálogo](https://tienda.mx/cat_2026)`;
const PLANO = (m) =>
  `Hola ${m}\nHorario: de 9 a 6\n• Martillos\n• Clavos agotados\nMira el catálogo: https://tienda.mx/cat_2026`;

let cookie = "";
let failures = 0;
let checks = 0;

function ok(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`  OK  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  let json = null;
  try {
    json = await res.clone().json();
  } catch {}
  return { res, json };
}

const bot = (path, opts = {}) =>
  api(path, { ...opts, headers: { "x-api-key": BOT_KEY, ...(opts.headers ?? {}) } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasta(cond, ms = 15000, paso = 200) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > fin) return null;
    await sleep(paso);
  }
}

// ---------------------------------------------------------------------------

let nEvento = 0;
/** Um `message.received` do Zernio; `hace` envelhece a mensagem do cliente. */
async function entranteSocial(red, { sender, nombre, text, hace = 0 }) {
  nEvento++;
  const hilo = `zconv-vs-${red}-${sender}`;
  const cuerpo = JSON.stringify({
    id: `evt-vs-${RUN}-${nEvento}`,
    event: "message.received",
    message: {
      id: `zmsg-vs-${RUN}-${nEvento}`,
      conversationId: hilo,
      platform: PLATAFORMA[red],
      direction: "incoming",
      text,
      attachments: [],
      sender: { id: sender, name: nombre, username: null },
      sentAt: new Date(Date.now() - hace).toISOString(),
    },
    conversation: { id: hilo },
    account: { id: CUENTA[red], accountId: CUENTA[red], platform: PLATAFORMA[red] },
  });
  const res = await fetch(`${BASE}/api/webhooks/ig/${VERIFY_TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zernio-signature": createHmac("sha256", SECRET).update(cuerpo).digest("hex"),
    },
    body: cuerpo,
  });
  return { status: res.status, hilo };
}

let nWa = 0;
const entranteWa = (from, name, text) =>
  api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from,
      name,
      text,
      waMessageId: `wamid.vs.${RUN}.${++nWa}`,
    }),
  });

const conversaciones = async () => (await api("/api/conversations")).json?.conversations ?? [];
// A ingestão roda depois de responder o webhook e grava `lastInboundAt` no final:
// aguarda-se a conversa JÁ com sua última mensagem recebida, que é do que
// depende a janela.
const convDe = (nombre) =>
  hasta(async () =>
    (await conversaciones()).find((c) => c.contact.name === nombre && c.lastInboundAt !== null)
  );
const mensajesDe = async (id) => (await api(`/api/conversations/${id}/messages`)).json?.messages ?? [];
const enviadosPorZernio = async (hilo) =>
  ((await api("/api/dev/zernio-mock/_sent")).json?.sent ?? []).filter((m) => m.conversationId === hilo);
const comoCerebro = (conversationId, text) =>
  bot("/api/bot/messages", { method: "POST", body: JSON.stringify({ conversationId, text }) });
const aMano = (conversationId, text) =>
  api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
const agente = (enabled) =>
  api("/api/agent/profile", { method: "PUT", body: JSON.stringify({ enabled }) });

/** Abre uma conversa social com uma mensagem do cliente de `hace` ms atrás. */
async function conversacion(red, etiqueta, hace = 0) {
  const sender = `${red}-${etiqueta}-${RUN}`;
  const nombre = `Cliente ${red} ${etiqueta} ${MARCA}`;
  const e = await entranteSocial(red, { sender, nombre, text: `hola ${etiqueta} ${MARCA}`, hace });
  const conv = e.status === 200 ? await convDe(nombre) : null;
  return { conv, hilo: e.hilo, sender, nombre, status: e.status };
}

// ---------------------------------------------------------------------------

async function main() {
  for (const c of ["instagram", "messenger", "tiktok"]) {
    if (!CHANNELS.includes(c)) {
      console.error(`CHANNELS no incluye \`${c}\`: arranca la app con los tres canales sociales.`);
      process.exit(1);
    }
  }
  if ((process.env.BRAIN_DISPATCH_URL ?? "").trim()) {
    console.error("La app tiene BRAIN_DISPATCH_URL: este guion necesita al agente incluido.");
    process.exit(1);
  }
  if (!BOT_KEY) {
    console.error("Falta BOT_API_KEY: el guion contesta como cerebro por /api/bot/messages.");
    process.exit(1);
  }

  console.log("== Setup ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del propietario", su.res.ok, JSON.stringify(su.json));

  await api("/api/dev/zernio-mock/_reset", { method: "POST" });
  await api("/api/dev/zernio-mock/_accounts", {
    method: "POST",
    body: JSON.stringify({
      accounts: [
        { _id: CUENTA.ig, platform: "instagram", username: "negocio.ig", platformUserId: `1784${RUN}`, isActive: true, platformStatus: "active" },
        { _id: CUENTA.fb, platform: "facebook", displayName: "Negocio Demo", isActive: true, platformStatus: "active", metadata: { selectedPageId: `page-${RUN}`, selectedPageName: "Negocio Demo" } },
        { _id: CUENTA.tt, platform: "tiktok", username: "negocio.tt", isActive: true, platformStatus: "active", tiktokAccountType: "business" },
      ],
    }),
  });
  await api("/api/dev/zernio-mock/_webhooks", { method: "POST", body: JSON.stringify({ webhooks: [] }) });
  const conexiones = [];
  for (const [canal, cuerpo] of [
    ["instagram", { source: "zernio", token: LLAVE, webhookSecret: SECRET }],
    ["messenger", { source: "zernio", token: LLAVE, webhookSecret: SECRET }],
    ["tiktok", { token: LLAVE, webhookSecret: SECRET }],
  ]) {
    conexiones.push((await api(`/api/settings/${canal}`, { method: "PUT", body: JSON.stringify(cuerpo) })).res.ok);
  }
  ok("Instagram, Messenger y TikTok conectados por Zernio (simulador)", conexiones.every(Boolean), JSON.stringify(conexiones));
  const wa = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ wabaId: "WABA-E2E", phoneNumberId: PN, token: "tok-e2e" }),
  });
  ok("WhatsApp conectado (wa-mock)", wa.res.ok, JSON.stringify(wa.json));
  // Desligado enquanto o roteiro faz de cérebro: assim só sai o que ele manda.
  ok("agente incluido apagado para la primera parte", (await agente(false)).res.ok);

  await textoPlano();
  await ventanaHumana();
  await agenteIncluido();

  console.log(`\n${checks - failures}/${checks} checks en verde`);
  process.exit(failures > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// D1 — Nas redes, o texto da IA sai puro
// ---------------------------------------------------------------------------

async function textoPlano() {
  console.log("\n== D1: el texto de la IA sale plano en redes ==");
  for (const red of ["ig", "fb", "tt"]) {
    const { conv, hilo } = await conversacion(red, "formato");
    if (!conv) {
      ok(`${CANAL[red]}: la conversación se abrió`, false);
      continue;
    }
    const marca = `${red} ${MARCA}`;
    const r = await comoCerebro(conv.id, CON_FORMATO(marca));
    ok(`${CANAL[red]}: el cerebro contesta → 200`, r.res.ok, `${r.res.status} ${JSON.stringify(r.json)}`);
    const salio = (await enviadosPorZernio(hilo)).at(-1);
    ok(
      `${CANAL[red]}: a la plataforma llega sin asteriscos, con viñetas y el enlace legible`,
      salio?.message === PLANO(marca),
      JSON.stringify(salio?.message)
    );
    const guardado = (await mensajesDe(conv.id)).filter((m) => m.direction === "out").at(-1);
    ok(
      `${CANAL[red]}: en el hilo queda lo mismo que leyó el cliente, marcado como IA`,
      guardado?.text === PLANO(marca) && guardado?.aiGenerated === true,
      JSON.stringify(guardado?.text)
    );
  }

  const { conv: convIg, hilo: hiloIg } = await conversacion("ig", "operador");
  const aManoTexto = `*esto* lo escribí _yo_ ${MARCA}`;
  const m = await aMano(convIg.id, aManoTexto);
  ok("Instagram: lo que escribe una persona sale → 200", m.res.ok, `${m.res.status} ${JSON.stringify(m.json)}`);
  ok(
    "y sale tal cual lo escribió, con sus asteriscos",
    (await enviadosPorZernio(hiloIg)).at(-1)?.message === aManoTexto,
    JSON.stringify((await enviadosPorZernio(hiloIg)).at(-1)?.message)
  );

  const nombreWa = `Cliente wa formato ${MARCA}`;
  const tel = `52155${String(Date.now() % 1_000_000).padStart(6, "0")}77`;
  await entranteWa(tel, nombreWa, `hola por whatsapp ${MARCA}`);
  const convWa = await convDe(nombreWa);
  const marcaWa = `wa ${MARCA}`;
  const rWa = await comoCerebro(convWa.id, CON_FORMATO(marcaWa));
  ok("WhatsApp: el cerebro contesta → 200", rWa.res.ok, `${rWa.res.status} ${JSON.stringify(rWa.json)}`);
  const outbox = JSON.stringify((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []);
  ok(
    "WhatsApp: el texto sale con su formato, sin tocar",
    outbox.includes(JSON.stringify(CON_FORMATO(marcaWa)).slice(1, -1)),
    ""
  );
  const guardadoWa = (await mensajesDe(convWa.id)).filter((x) => x.direction === "out").at(-1);
  ok("WhatsApp: y así queda en el hilo", guardadoWa?.text === CON_FORMATO(marcaWa), JSON.stringify(guardadoWa?.text));
}

// ---------------------------------------------------------------------------
// D2–D4 — A janela de atendimento humano
// ---------------------------------------------------------------------------

async function ventanaHumana() {
  console.log("\n== D3: quién puede escribir pasadas 24 horas ==");
  for (const red of ["ig", "fb"]) {
    const canal = CANAL[red];

    // Dentro das 24 horas: normal, sem etiqueta.
    const dentro = await conversacion(red, "23h", 23 * HORA);
    ok(
      `${canal} a las 23 h: ventana abierta y sin atención humana en la bandeja`,
      dentro.conv?.windowOpen === true && dentro.conv?.humanWindow?.open === false,
      JSON.stringify({ w: dentro.conv?.windowOpen, h: dentro.conv?.humanWindow })
    );
    await aMano(dentro.conv.id, `respuesta a tiempo ${MARCA}`);
    const sinEtiqueta = (await enviadosPorZernio(dentro.hilo)).at(-1);
    ok(
      `${canal} a las 23 h: la respuesta sale sin etiqueta`,
      sinEtiqueta && !sinEtiqueta.messageTag,
      JSON.stringify(sinEtiqueta)
    );

    // Entre 24 horas e 7 dias: só uma pessoa, com a etiqueta.
    const en = await conversacion(red, "30h", 30 * HORA);
    const h = en.conv?.humanWindow;
    ok(
      `${canal} a las 30 h: la bandeja dice atención humana y cuánto queda (~6 días)`,
      en.conv?.windowOpen === false &&
        h?.open === true &&
        h.remainingMs > 7 * DIA - 31 * HORA &&
        h.remainingMs <= 7 * DIA - 30 * HORA,
      JSON.stringify({ w: en.conv?.windowOpen, h })
    );
    const ia = await comoCerebro(en.conv.id, `respuesta automática ${MARCA}`);
    ok(
      `${canal} a las 30 h: la IA no puede → 409 window_closed que lo explica`,
      ia.res.status === 409 &&
        ia.json?.error?.code === "window_closed" &&
        ia.json?.error?.message?.includes("una persona"),
      `${ia.res.status} ${JSON.stringify(ia.json)}`
    );
    ok(`${canal} a las 30 h: y a la plataforma no salió nada`, (await enviadosPorZernio(en.hilo)).length === 0);
    const persona = await aMano(en.conv.id, `te contesto yo ${MARCA}`);
    ok(`${canal} a las 30 h: una persona sí → 200`, persona.res.ok, `${persona.res.status} ${JSON.stringify(persona.json)}`);
    const conEtiqueta = (await enviadosPorZernio(en.hilo)).at(-1);
    ok(
      `${canal} a las 30 h: sale con la etiqueta de agente humano`,
      conEtiqueta?.messagingType === "MESSAGE_TAG" && conEtiqueta?.messageTag === "HUMAN_AGENT",
      JSON.stringify(conEtiqueta)
    );
    const tras = (await conversaciones()).find((c) => c.id === en.conv.id);
    ok(
      `${canal}: contestar no alarga el plazo (cuenta el último mensaje del cliente)`,
      tras?.humanWindow?.open === true && tras.humanWindow.remainingMs <= h.remainingMs,
      JSON.stringify(tras?.humanWindow)
    );

    // Passados 7 dias: ninguém.
    const fuera = await conversacion(red, "8d", 8 * DIA);
    ok(
      `${canal} a los 8 días: la bandeja la da por cerrada`,
      fuera.conv?.windowOpen === false && fuera.conv?.humanWindow?.open === false,
      JSON.stringify({ w: fuera.conv?.windowOpen, h: fuera.conv?.humanWindow })
    );
    const tarde = await aMano(fuera.conv.id, `ya es tarde ${MARCA}`);
    ok(
      `${canal} a los 8 días: ni una persona → 409 window_closed que dice 7 días`,
      tarde.res.status === 409 &&
        tarde.json?.error?.code === "window_closed" &&
        tarde.json?.error?.message?.includes("7 días"),
      `${tarde.res.status} ${JSON.stringify(tarde.json)}`
    );
    const tardeIa = await comoCerebro(fuera.conv.id, `ya es tarde ${MARCA}`);
    ok(`${canal} a los 8 días: ni la IA → 409`, tardeIa.res.status === 409, String(tardeIa.res.status));
    ok(`${canal} a los 8 días: a la plataforma no salió nada`, (await enviadosPorZernio(fuera.hilo)).length === 0);

    // O cliente volta a escrever: tudo se abre de novo.
    await entranteSocial(red, { sender: fuera.sender, nombre: fuera.nombre, text: `ya volví ${MARCA}` });
    const reabierta = await hasta(async () => {
      const c = (await conversaciones()).find((x) => x.id === fuera.conv.id);
      return c?.windowOpen ? c : null;
    });
    ok(`${canal}: si el cliente vuelve a escribir, la ventana se reabre`, Boolean(reabierta));
    const otraVez = await comoCerebro(fuera.conv.id, `bienvenido de vuelta ${MARCA}`);
    ok(`${canal}: y la IA puede contestar de nuevo`, otraVez.res.ok, `${otraVez.res.status} ${JSON.stringify(otraVez.json)}`);
  }

  console.log("\n== Los canales sin extensión no cambian ==");
  const tt = await conversacion("tt", "30h", 30 * HORA);
  ok(
    "TikTok no tiene atención humana: su ventana de 48 h sigue abierta a las 30",
    tt.conv?.humanWindow === null && tt.conv?.windowOpen === true,
    JSON.stringify({ w: tt.conv?.windowOpen, h: tt.conv?.humanWindow })
  );
  const ttIa = await comoCerebro(tt.conv.id, `hola desde la IA ${MARCA}`);
  ok("y ahí la IA sí contesta → 200", ttIa.res.ok, `${ttIa.res.status} ${JSON.stringify(ttIa.json)}`);
  const convWa = (await conversaciones()).find((c) => c.channel === "whatsapp");
  ok("WhatsApp tampoco la tiene", convWa?.humanWindow === null, JSON.stringify(convWa?.humanWindow));

  // 028 · D1 — O compositor só oferece o que o canal pode enviar.
  console.log("\n== 028: lo que el compositor ofrece por canal ==");
  const todas = await conversaciones();
  ok(
    "WhatsApp: adjuntos, ubicación y contacto",
    convWa?.composer?.media === true && convWa?.composer?.structured === true,
    JSON.stringify(convWa?.composer)
  );
  for (const canal of ["instagram", "messenger", "tiktok"]) {
    const c = todas.find((x) => x.channel === canal);
    ok(
      `${canal}: la caja de texto sola`,
      c?.composer?.media === false && c?.composer?.structured === false,
      JSON.stringify(c?.composer)
    );
  }
}

// ---------------------------------------------------------------------------
// O agente incluído também sai puro
// ---------------------------------------------------------------------------

async function agenteIncluido() {
  console.log("\n== El agente incluido contesta plano en redes ==");
  ok("agente incluido encendido", (await agente(true)).res.ok);
  const sender = `ig-agente-${RUN}`;
  const nombre = `Cliente ig agente ${MARCA}`;
  // O simulador de IA repete o que o cliente disse: se o cliente manda
  // asteriscos, a resposta do agente os traz.
  const dicho = `quiero el *martillo* de **bola** ${MARCA}`;
  const e = await entranteSocial("ig", { sender, nombre, text: dicho });
  const conv = e.status === 200 ? await convDe(nombre) : null;
  const respuesta = await hasta(
    async () => (await mensajesDe(conv.id)).find((m) => m.direction === "out" && m.aiGenerated),
    COALESCE + 15000
  );
  ok("el agente contestó", Boolean(respuesta), "sin respuesta del agente");
  if (!respuesta) return;
  ok(
    "su respuesta repite al cliente pero sin las marcas",
    respuesta.text.includes(`quiero el martillo de bola ${MARCA}`) && !/\*/.test(respuesta.text),
    JSON.stringify(respuesta.text)
  );
  const salio = (await enviadosPorZernio(e.hilo)).at(-1);
  ok("y así llegó a Instagram", salio?.message === respuesta.text && !salio.messageTag, JSON.stringify(salio));
  await agente(false);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
