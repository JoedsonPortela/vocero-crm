/**
 * Self-test E2E de comportamento — 021: despacho padrão (#89) e 025: o
 * despacho lembra o que deve.
 *
 * Conduz a app real com os mocks de canal e faz o papel de CÉREBRO: sobe um
 * servidor HTTP em `BRAIN_DISPATCH_URL`, neste processo (outro, distinto do
 * CRM), recebe os despachos, verifica a assinatura sobre o corpo cru como
 * deve fazer um cérebro de verdade e responde por `/api/bot/messages`. Assim o
 * turno cruza HTTP de verdade nas duas direções.
 *
 * Uso:
 *   1) app rodando (`next dev`) sobre um banco migrado, com
 *      WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      OPENROUTER_BASE_URL → ai-mock + OPENROUTER_API_TOKEN + OPENROUTER_MODEL,
 *      BOT_API_KEY, AGENT_COALESCE_MS curto (1500) e
 *      BRAIN_DISPATCH_URL=http://127.0.0.1:<porta livre>/vocero/dispatch.
 *      Com CHANNELS=whatsapp,instagram,messenger,tiktok também rodam esses
 *      canais (Instagram e TikTok entram pelo Zernio: ZERNIO_BASE_URL →
 *      zernio-mock).
 *   2) node --env-file=.env scripts/e2e-despacho.mjs
 *
 * Dois modos, conforme como a app iniciou (025):
 *   - com BRAIN_DISPATCH_URL: tudo o que está acima, o roteiro do cérebro;
 *   - sem ela: responde o agente incluído, e se confere o que lhe cabe a ele
 *     (uma mensagem que entra enquanto o modelo pensa; uma pessoa que
 *     responde dentro da janela). Não é preciso BOT_API_KEY.
 * O gate completo são as duas execuções.
 *
 * Sai com código 1 se alguma verificação falhar. Roteiro: tests/e2e/us-despacho.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY ?? "";
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN ?? "";
const COALESCE = Number(process.env.AGENT_COALESCE_MS ?? 6000);
const CHANNELS = (process.env.CHANNELS ?? "").split(",").map((c) => c.trim());
const PN = "PN-E2E-1";
const RUN = Date.now().toString(36);
/** Marca desta execução: o harness pode ser repetido sobre o mesmo banco. */
const MARCA = `#${RUN}`;
/** Seis dígitos da execução, para telefones que não colidam entre execuções. */
const DIGITOS = String(Date.now() % 1_000_000).padStart(6, "0");
const telefono = (n) => `52155${DIGITOS}${String(n).padStart(2, "0")}`;

const CLAVES_DEL_EVENTO = [
  "dispatchId",
  "organization",
  "conversation",
  "contact",
  "messages",
  "firstMessageAt",
  "lastMessageAt",
];

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

/** Espera até que algo ACONTEÇA, em vez de dormir um pouco e confiar. */
async function hasta(cond, ms = 15000, paso = 250) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > fin) return null;
    await sleep(paso);
  }
}

// ---------------------------------------------------------------------------
// O cérebro de teste
// ---------------------------------------------------------------------------

function firmaOk(crudo, cabecera) {
  if (typeof cabecera !== "string" || !cabecera.startsWith("sha256=")) return false;
  const esperada = Buffer.from(
    `sha256=${createHmac("sha256", BOT_KEY).update(crudo).digest("hex")}`
  );
  const recibida = Buffer.from(cabecera);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

async function levantarCerebro(url) {
  const estado = {
    /** "ok" | "500" | "422" | "lento" */
    modo: "ok",
    lentoMs: 3000,
    recibidos: [],
  };
  const server = createServer((req, res) => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== url.pathname) {
      res.writeHead(404);
      return res.end();
    }
    const trozos = [];
    req.on("data", (c) => trozos.push(c));
    req.on("end", () => {
      // O corpo CRU, antes de parsear: é sobre isto que se assina.
      const crudo = Buffer.concat(trozos);
      let evento = null;
      try {
        evento = JSON.parse(crudo.toString("utf8"));
      } catch {}
      estado.recibidos.push({
        at: Date.now(),
        modo: estado.modo,
        crudo: crudo.toString("utf8"),
        evento,
        firmaOk: firmaOk(crudo, req.headers["x-vocero-signature"]),
        cabeceras: {
          dispatch: req.headers["x-vocero-dispatch-id"] ?? null,
          org: req.headers["x-vocero-organization"] ?? null,
          evento: req.headers["x-vocero-event"] ?? null,
          tipo: req.headers["content-type"] ?? null,
        },
      });
      const responder = (status) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status < 300 ? { status: "ok" } : { error: "simulado" }));
      };
      if (estado.modo === "500") return responder(500);
      if (estado.modo === "422") return responder(422);
      if (estado.modo === "lento") return setTimeout(() => responder(200), estado.lentoMs);
      return responder(200);
    });
  });
  const escuchar = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ""), resolve);
    });
  await escuchar();
  return {
    estado,
    de: (convId) => estado.recibidos.filter((r) => r.evento?.conversation?.id === convId),
    apagar: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    encender: escuchar,
  };
}

// ---------------------------------------------------------------------------
// Atalhos do roteiro
// ---------------------------------------------------------------------------

let nMensaje = 0;
async function entranteWa(from, name, text, extra = {}) {
  nMensaje++;
  return api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from,
      name,
      text,
      waMessageId: `wamid.despacho.${RUN}.${nMensaje}`,
      ...extra,
    }),
  });
}

async function conversaciones() {
  return (await api("/api/conversations")).json?.conversations ?? [];
}

const convDe = (name) =>
  hasta(async () => (await conversaciones()).find((c) => c.contact.name === name));

async function mensajesDe(convId) {
  return (await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
}

const estadoCerebro = async () => (await api("/api/agent/brain-status")).json;

/** O que o operador escreve pela bandeja. */
const aMano = (convId, text) =>
  api(`/api/conversations/${convId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });

/** Espera até que esse texto do cliente esteja salvo; devolve a mensagem. */
const entranteGuardado = (convId, text) =>
  hasta(
    async () => (await mensajesDe(convId)).find((m) => m.direction === "in" && m.text === text),
    5000,
    60
  );

/** O mock de IA: `?reset=1`, `?demoraMs=3000`; devolve o que lhe foi perguntado. */
const iaMock = async (qs = "") =>
  (await api(`/api/dev/ai-mock/v1/chat/completions${qs}`)).json ?? {};

/** As requisições ao modelo de UMA conversa: as que trazem esse texto. */
const peticionesCon = async (texto) =>
  ((await iaMock()).peticiones ?? []).filter((p) =>
    p.mensajes.some((m) => m.content === texto)
  );

/**
 * Há casos que dependem de ganhar da janela de agrupamento: algo precisa
 * acontecer ANTES de ela vencer. Numa máquina carregada pode-se perder essa
 * corrida, e aí o caso não prova nada. `preparar` devolve `null`
 * quando a perdeu; tenta-se de novo com outro contato em vez de acusar o
 * produto de algo que fez o roteiro.
 */
async function conLaVentanaAbierta(preparar, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    const listo = await preparar(i);
    if (listo) return listo;
    console.log(`  (la ventana venció antes de tiempo; intento ${i} de ${intentos})`);
    await sleep(TRAS_LA_VENTANA);
  }
  return null;
}

/** O tempo que leva para vencer a janela, mais uma margem para o worker e o `next dev`. */
const TRAS_LA_VENTANA = COALESCE + 4000;

// ---------------------------------------------------------------------------

async function main() {
  if (!(process.env.BRAIN_DISPATCH_URL ?? "").trim()) {
    console.log("Sin BRAIN_DISPATCH_URL: modo AGENTE INCLUIDO (025).\n");
    await guionIncluido();
    console.log(`\n${checks - failures}/${checks} checks en verde`);
    process.exit(failures > 0 ? 1 : 0);
  }
  if (BOT_KEY.length < 16) {
    console.error("BOT_API_KEY ausente o corta (<16): sin ella no hay despacho.");
    process.exit(1);
  }
  let url;
  try {
    url = new URL(process.env.BRAIN_DISPATCH_URL ?? "");
  } catch {
    console.error(
      "Falta BRAIN_DISPATCH_URL. Arranca la app con algo como\n" +
        "  BRAIN_DISPATCH_URL=http://127.0.0.1:3190/vocero/dispatch\n" +
        "y corre este guion con el mismo entorno."
    );
    process.exit(1);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    console.error(
      `BRAIN_DISPATCH_URL apunta a ${url.host}: este guion levanta el cerebro de prueba en esta máquina.`
    );
    process.exit(1);
  }

  const cerebro = await levantarCerebro(url);
  try {
    await guion(cerebro, url);
  } finally {
    await cerebro.apagar().catch(() => {});
  }

  console.log(`\n${checks - failures}/${checks} checks en verde`);
  process.exit(failures > 0 ? 1 : 0);
}

/** Operador, WhatsApp pelo wa-mock e o interruptor do agente ligados. */
async function preparar() {
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
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));

  const conn = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ wabaId: "WABA-E2E", phoneNumberId: PN, token: "tok-e2e" }),
  });
  ok("conexión de WhatsApp guardada (wa-mock)", conn.res.ok, JSON.stringify(conn.json));
  await api("/api/dev/wa-mock/outbox", { method: "DELETE" });

  // De propósito: com IA configurada e o interruptor ligado, o agente
  // incluído responderia. O despacho precisa silenciá-lo.
  const perfil = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  ok("interruptor del agente incluido encendido", perfil.res.ok, JSON.stringify(perfil.json));
}

async function guion(cerebro, url) {
  console.log("== Setup: operador, WhatsApp y agente incluido ENCENDIDO ==");
  await preparar();

  const antes = await estadoCerebro();
  ok(
    "el CRM dice que el despacho está activo",
    antes?.dispatch?.active === true && antes?.dispatch?.problem === null,
    JSON.stringify(antes?.dispatch)
  );
  if (antes?.dispatch?.active !== true) {
    console.error(
      "\nLa app no tiene el despacho activo: revisa que arrancó con BRAIN_DISPATCH_URL y BOT_API_KEY."
    );
    return;
  }
  ok(
    "el agente incluido tiene con qué contestar (IA + interruptor), y está en silencio",
    antes.embedded?.configured === true &&
      antes.embedded?.enabled === true &&
      antes.embedded?.silenced === true &&
      antes.embedded?.answering === false,
    JSON.stringify(antes.embedded)
  );
  ok("sin aviso de doble respuesta", antes.warning === null, String(antes.warning));

  await unMensaje(cerebro);
  await rafaga(cerebro);
  await enVuelo(cerebro);
  await mientrasPiensa(cerebro);
  await personaEnLaVentana(cerebro);
  await adjunto(cerebro);
  await otrosCanales(cerebro);
  await pausas(cerebro);
  await laboratorio(cerebro);
  await cerebroCaido(cerebro);
  await tarjeta(cerebro, url);
}

// ---------------------------------------------------------------------------
// História 1 — uma mensagem chega ao cérebro
// ---------------------------------------------------------------------------

async function unMensaje(cerebro) {
  console.log("\n== AC1: un WhatsApp llega al cerebro, firmado, y la respuesta sale ==");
  const nombre = `Ana Despacho ${MARCA}`;
  const texto = `hola, ¿tienen el modelo azul? ${MARCA}`;
  const t0 = Date.now();
  const inb = await entranteWa(telefono(1), nombre, texto);
  ok("el entrante se entregó al webhook", inb.res.ok, JSON.stringify(inb.json));

  const conv = await convDe(nombre);
  ok("el mensaje está en la bandeja antes de cualquier despacho", Boolean(conv));
  if (!conv) return;

  const llego = await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000);
  ok("el cerebro recibió un despacho", Boolean(llego));
  if (!llego) return;
  ok(
    `esperó la ventana de agrupado (${COALESCE} ms) antes de despachar`,
    llego.at - t0 >= COALESCE - 250,
    `${llego.at - t0} ms`
  );

  const e = llego.evento;
  ok("la firma valida sobre el cuerpo crudo con BOT_API_KEY", llego.firmaOk);
  ok(
    "con las cabeceras del contrato",
    llego.cabeceras.dispatch === e.dispatchId &&
      Boolean(llego.cabeceras.org) &&
      llego.cabeceras.evento === null &&
      String(llego.cabeceras.tipo).startsWith("application/json"),
    JSON.stringify(llego.cabeceras)
  );
  ok("dispatchId con prefijo dsp_", /^dsp_[0-9a-z]{20}$/.test(e.dispatchId), e.dispatchId);
  ok(
    "las claves del evento, en el orden del contrato",
    JSON.stringify(Object.keys(e)) === JSON.stringify(CLAVES_DEL_EVENTO),
    Object.keys(e).join(",")
  );
  ok(
    "conversación: la de la bandeja, canal whatsapp, IA activa y ventana abierta",
    e.conversation.id === conv.id &&
      e.conversation.channel === "whatsapp" &&
      e.conversation.aiEnabled === true &&
      e.conversation.windowOpen === true &&
      typeof e.conversation.windowExpiresAt === "string",
    JSON.stringify(e.conversation)
  );
  ok(
    "un mensaje, el del cliente, sin adjunto",
    e.messages.length === 1 &&
      e.messages[0].text === texto &&
      e.messages[0].type === "text" &&
      e.messages[0].mediaId === null &&
      !("mimeType" in e.messages[0]),
    JSON.stringify(e.messages)
  );
  ok(
    "el evento no lleva el token de WhatsApp ni la llave",
    !llego.crudo.includes("tok-e2e") && !llego.crudo.includes(BOT_KEY)
  );

  const ctx = await bot(`/api/bot/context?conversationId=${conv.id}`);
  ok("el cerebro lee el contexto por conversationId", ctx.res.ok, String(ctx.res.status));
  const identidadCrm = ctx.json?.contact?.identity ?? ctx.json?.contact?.waIdentity;
  ok(
    "la identidad del evento es la que acepta /api/bot/context",
    Boolean(identidadCrm) && e.contact.identity === identidadCrm && e.contact.displayName === nombre,
    `${e.contact.identity} vs ${identidadCrm}`
  );

  const respuesta = `Sí, lo tenemos en azul ${MARCA}`;
  const envio = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: e.conversation.id, text: respuesta }),
  });
  ok("el cerebro contesta por /api/bot/messages → 200", envio.res.ok, JSON.stringify(envio.json));
  const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok("la respuesta salió por WhatsApp (wa-mock)", JSON.stringify(outbox).includes(respuesta));

  console.log("\n== AC10: el agente incluido no contestó ==");
  await sleep(TRAS_LA_VENTANA);
  const salientes = (await mensajesDe(conv.id)).filter((m) => m.direction === "out");
  ok(
    "el único saliente es el del cerebro",
    salientes.length === 1 && salientes[0].text === respuesta,
    JSON.stringify(salientes.map((m) => m.text))
  );
  ok("y el cerebro recibió ese turno una sola vez", cerebro.de(conv.id).length === 1);
}

async function rafaga(cerebro) {
  console.log("\n== AC2: cinco mensajes seguidos → un despacho ==");
  const nombre = `Beto Ráfaga ${MARCA}`;
  const textos = [1, 2, 3, 4, 5].map((i) => `mensaje ${i} de la ráfaga ${MARCA}`);
  /**
   * Cada mensagem é aguardada na bandeja antes de enviar a próxima. O
   * webhook responde 200 e DEPOIS ingere (`after`): enviar as cinco sem
   * esperar é colocar cinco ingestões para rodar ao mesmo tempo, e a ordem em que
   * são salvas deixa de ser a ordem em que foram enviadas. O «em ordem» abaixo
   * ficava vermelho de vez em quando por isso, não por causa do despacho. Continuam
   * caindo todas dentro da janela, que cada uma empurra.
   */
  let conv = null;
  for (const t of textos) {
    await entranteWa(telefono(2), nombre, t);
    conv ??= await convDe(nombre);
    if (conv) await entranteGuardado(conv.id, t);
  }
  if (!conv) return ok("la conversación de la ráfaga existe", false);

  const llego = await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000);
  ok("llegó un despacho", Boolean(llego));
  await sleep(TRAS_LA_VENTANA);
  const todos = cerebro.de(conv.id);
  ok("exactamente uno", todos.length === 1, String(todos.length));
  ok(
    "con los cinco mensajes, en orden",
    JSON.stringify(todos[0]?.evento.messages.map((m) => m.text)) === JSON.stringify(textos),
    JSON.stringify(todos[0]?.evento.messages.map((m) => m.text))
  );
  ok(
    "firstMessageAt ≤ lastMessageAt",
    Date.parse(todos[0]?.evento.firstMessageAt) <= Date.parse(todos[0]?.evento.lastMessageAt)
  );
}

async function enVuelo(cerebro) {
  console.log("\n== AC5: un mensaje que llega con el despacho en vuelo no se pierde ==");
  const nombre = `Caro EnVuelo ${MARCA}`;
  cerebro.estado.lentoMs = 3000;
  cerebro.estado.modo = "lento";
  try {
    await entranteWa(telefono(3), nombre, `primero ${MARCA}`);
    const conv = await convDe(nombre);
    if (!conv) return ok("la conversación existe", false);
    const primero = await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000, 50);
    ok("el primer despacho está en vuelo (el cerebro tarda 3 s en acusar)", Boolean(primero));
    // Justo agora: o CRM ainda espera o 2xx do primeiro.
    await entranteWa(telefono(3), nombre, `segundo ${MARCA}`);
    cerebro.estado.modo = "ok";

    const segundo = await hasta(() => cerebro.de(conv.id)[1], 3000 + COALESCE + 12000);
    ok("llega un segundo despacho", Boolean(segundo));
    ok(
      "con otro dispatchId",
      Boolean(segundo) && segundo.evento.dispatchId !== primero?.evento.dispatchId
    );
    ok(
      "que trae la ráfaga completa: lo ya despachado y lo nuevo",
      JSON.stringify(segundo?.evento.messages.map((m) => m.text)) ===
        JSON.stringify([`primero ${MARCA}`, `segundo ${MARCA}`]),
      JSON.stringify(segundo?.evento.messages.map((m) => m.text))
    );
  } finally {
    cerebro.estado.modo = "ok";
  }
}

// ---------------------------------------------------------------------------
// 025 — O despacho lembra o que deve
// ---------------------------------------------------------------------------

async function mientrasPiensa(cerebro) {
  console.log("\n== 025·AC1: un mensaje que entra mientras el cerebro PIENSA viaja aunque ya haya respuesta ==");
  /**
   * Não é o buraco do AC5: aqui o despacho JÁ foi entregue. O cérebro acusou
   * recebimento e está pensando (10 a 40 s na vida real), o cliente escreve outra
   * vez, e a resposta à primeira mensagem sai antes de a janela do segundo vencer.
   * O lote é cortado na última saída, então essa segunda mensagem ficava ATRÁS
   * da resposta e ninguém a despachava.
   */
  const caso = await conLaVentanaAbierta(async (i) => {
    const nombre = `Lalo Pensando ${i} ${MARCA}`;
    const uno = `hola, ¿tienen taladros? ${i} ${MARCA}`;
    const dos = `¿y hacen envíos a Celaya? ${i} ${MARCA}`;
    await entranteWa(telefono(20 + i), nombre, uno);
    const conv = await convDe(nombre);
    if (!conv) return null;
    const primero = await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000, 50);
    if (!primero) return null;

    await entranteWa(telefono(20 + i), nombre, dos);
    const segundo = await entranteGuardado(conv.id, dos);
    const respuesta = await bot("/api/bot/messages", {
      method: "POST",
      body: JSON.stringify({ conversationId: conv.id, text: `Sí tenemos taladros ${i} ${MARCA}` }),
    });
    // Se a resposta chegasse DEPOIS da janela, o segundo despacho já teria saído
    // pelo caminho de sempre e o caso passaria sem provar nada.
    if (!segundo || !respuesta.res.ok || cerebro.de(conv.id).length !== 1) return null;
    return { conv, primero, segundo, uno, dos };
  });
  ok(
    "el cerebro contesta el primero con la ventana del segundo todavía abierta",
    Boolean(caso)
  );
  if (!caso) return;
  const { conv, primero, segundo, dos } = caso;

  const llego = await hasta(() => cerebro.de(conv.id)[1], COALESCE + 12000);
  ok("llega un segundo despacho", Boolean(llego));
  ok(
    "con exactamente el segundo mensaje: ni vacío ni repitiendo el ya contestado",
    llego?.evento.messages.length === 1 &&
      llego.evento.messages[0].id === segundo.id &&
      llego.evento.messages[0].text === dos,
    JSON.stringify(llego?.evento.messages.map((m) => ({ id: m.id, text: m.text })))
  );
  ok(
    "firmado, y con otro dispatchId",
    llego?.firmaOk === true && llego.evento.dispatchId !== primero.evento.dispatchId
  );

  console.log("\n== 025·AC2: y no deja nada colgando ==");
  await sleep(TRAS_LA_VENTANA);
  ok(
    "no hay un tercer despacho: lo ya entregado no se vuelve a deber",
    cerebro.de(conv.id).length === 2,
    String(cerebro.de(conv.id).length)
  );
  const despues = (await conversaciones()).find((c) => c.id === conv.id);
  ok(
    "la conversación sigue con la IA, sin traspaso",
    despues?.aiEnabled === true && !despues?.handoffAt,
    JSON.stringify({ ai: despues?.aiEnabled, handoffAt: despues?.handoffAt, reason: despues?.handoffReason })
  );
  ok("no queda nada en espera", (await estadoCerebro())?.dispatch?.pending === 0);
}

async function personaEnLaVentana(cerebro) {
  console.log("\n== 025·AC4: si una persona contesta dentro de la ventana, el cerebro no recibe nada ==");
  /**
   * O outro lado. Que uma mensagem viaje mesmo que tenha uma resposta depois vale
   * para a resposta do AGENTE, que não a tinha lido. Se respondeu uma pessoa,
   * essa mensagem já está atendida: mandá-la ao cérebro seria responder duas vezes
   * ao cliente. E um despacho sem mensagens não é entregue.
   */
  const fallosAntes = (await estadoCerebro())?.dispatch?.lastFailure?.at ?? null;
  const caso = await conLaVentanaAbierta(async (i) => {
    const nombre = `Mara Atendida ${i} ${MARCA}`;
    await entranteWa(telefono(30 + i), nombre, `¿a qué hora cierran? ${i} ${MARCA}`);
    const conv = await convDe(nombre);
    if (!conv) return null;
    const envio = await aMano(conv.id, `Cerramos a las 7 ${i} ${MARCA}`);
    if (!envio.res.ok || cerebro.de(conv.id).length !== 0) return null;
    return { conv, nombre, i };
  });
  ok("una persona contesta con la ventana todavía abierta", Boolean(caso));
  if (!caso) return;
  const { conv, nombre, i } = caso;

  await sleep(TRAS_LA_VENTANA);
  ok(
    "el cerebro no recibe nada: ni el mensaje ya atendido ni un despacho vacío",
    cerebro.de(conv.id).length === 0,
    JSON.stringify(cerebro.de(conv.id).map((r) => ({ id: r.evento?.dispatchId, mensajes: r.evento?.messages?.length })))
  );

  console.log("\n== 025·AC5: se descarta, no cuenta como caída ==");
  const st = await estadoCerebro();
  ok("no queda nada en espera", st?.dispatch?.pending === 0, JSON.stringify(st?.dispatch));
  ok(
    "no se registró ningún fallo nuevo del cerebro",
    (st?.dispatch?.lastFailure?.at ?? null) === fallosAntes,
    JSON.stringify(st?.dispatch?.lastFailure)
  );
  const despues = (await conversaciones()).find((c) => c.id === conv.id);
  ok(
    "la conversación NO pasó a un humano: la IA sigue encendida",
    despues?.aiEnabled === true && !despues?.handoffAt,
    JSON.stringify({ ai: despues?.aiEnabled, handoffAt: despues?.handoffAt, reason: despues?.handoffReason })
  );

  const otro = `¿y los domingos? ${i} ${MARCA}`;
  await entranteWa(telefono(30 + i), nombre, otro);
  const llego = await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000);
  ok(
    "el siguiente mensaje del cliente sí se despacha, y solo ese",
    llego?.evento.messages.length === 1 && llego.evento.messages[0].text === otro,
    JSON.stringify(llego?.evento.messages.map((m) => m.text))
  );
}

async function adjunto(cerebro) {
  console.log("\n== AC4: un adjunto viaja como mediaId y se descarga por /api/bot/media ==");
  const nombre = `Dani Adjunto ${MARCA}`;
  const mediaId = "media123";
  await entranteWa(telefono(4), nombre, undefined, {
    type: "image",
    mediaId,
    mimeType: "image/jpeg",
    caption: `foto ${MARCA}`,
  });
  const conv = await convDe(nombre);
  if (!conv) return ok("la conversación existe", false);
  const llego = await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000);
  const m = llego?.evento.messages[0];
  ok(
    "el evento trae mediaId, mimeType y caption",
    m?.type === "image" && m?.mediaId === mediaId && m?.mimeType === "image/jpeg" && m?.caption === `foto ${MARCA}`,
    JSON.stringify(m)
  );
  ok("y no el archivo", !llego?.crudo.includes("base64"));
  if (m?.mediaId) {
    const media = await fetch(`${BASE}/api/bot/media/${m.mediaId}`, {
      headers: { "x-api-key": BOT_KEY },
    });
    const bytes = (await media.arrayBuffer()).byteLength;
    ok(
      "ese mediaId se descarga por /api/bot/media",
      media.status === 200 && bytes > 0 && String(media.headers.get("content-type")).startsWith("image/"),
      `${media.status} ${media.headers.get("content-type")} ${bytes} bytes`
    );
  }
}

/**
 * 023: salvar uma conexão pelo Zernio resolve a conta contra as da chave,
 * então o simulador tem de servi-las.
 */
async function sembrarCuentasDeZernio() {
  await api("/api/dev/zernio-mock/_accounts", {
    method: "POST",
    body: JSON.stringify({
      accounts: [
        {
          _id: "zernio-ig-despacho",
          platform: "instagram",
          username: "ig.despacho",
          platformUserId: "ig-user-despacho",
          isActive: true,
          platformStatus: "active",
        },
        {
          _id: "zernio-tt-despacho",
          platform: "tiktok",
          username: "tt.despacho",
          isActive: true,
          platformStatus: "active",
          tiktokAccountType: "business",
        },
      ],
    }),
  });
  await api("/api/dev/zernio-mock/_webhooks", {
    method: "POST",
    body: JSON.stringify({ webhooks: [] }),
  });
}

async function otrosCanales(cerebro) {
  console.log("\n== AC3: Messenger e Instagram se despachan igual ==");
  if (!CHANNELS.includes("messenger")) {
    console.log("  SKIP Messenger: CHANNELS no lo incluye");
  } else {
    const PAGE = "page-demo-001";
    const psid = `psid-despacho-${RUN}`;
    const c = await api("/api/settings/messenger", {
      method: "PUT",
      body: JSON.stringify({ source: "meta", pageId: PAGE, token: "token-pagina-demo" }),
    });
    ok("página de Messenger conectada (wa-mock)", c.res.ok, JSON.stringify(c.json));
    const texto = `hola por Messenger ${MARCA}`;
    const wh = await fetch(`${BASE}/api/webhooks/messenger/${VERIFY_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object: "page",
        entry: [
          {
            id: PAGE,
            time: Date.now(),
            messaging: [
              {
                sender: { id: psid },
                recipient: { id: PAGE },
                timestamp: Date.now(),
                message: { mid: `m_${psid}_1`, text: texto },
              },
            ],
          },
        ],
      }),
    });
    ok("el webhook de Messenger respondió 200", wh.status === 200, String(wh.status));
    const conv = await hasta(async () =>
      (await conversaciones()).find((x) => x.channel === "messenger" && x.preview?.includes(MARCA))
    );
    const llego = conv ? await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000) : null;
    ok(
      "despacho con canal messenger e identidad fb:",
      llego?.evento.conversation.channel === "messenger" &&
        llego?.evento.contact.identity === `fb:${psid}` &&
        llego?.evento.messages[0]?.text === texto &&
        llego?.firmaOk === true,
      JSON.stringify({ c: llego?.evento.conversation.channel, i: llego?.evento.contact.identity })
    );
    if (llego) {
      const r = await bot("/api/bot/messages", {
        method: "POST",
        body: JSON.stringify({ conversationId: conv.id, text: `claro, por aquí mismo ${MARCA}` }),
      });
      ok("el cerebro contesta por el mismo /api/bot/messages", r.res.ok, JSON.stringify(r.json));
    }
  }

  if (!CHANNELS.includes("instagram")) {
    console.log("  SKIP Instagram: CHANNELS no lo incluye");
    return;
  }
  // O Instagram entra pelo Zernio e o Messenger pela Meta: o cérebro recebe o
  // mesmo evento venha de onde vier. Só contra o mock: sem ele, salvar a
  // conexão perguntaria à API real do Zernio.
  if (!(process.env.ZERNIO_BASE_URL ?? "").includes("/api/dev/zernio-mock")) {
    console.log("  SKIP Instagram: ZERNIO_BASE_URL no apunta al zernio-mock");
    return;
  }
  const CUENTA = "zernio-ig-despacho";
  const SECRETO = "secreto-del-webhook-de-zernio";
  const igsid = `igsid-despacho-${RUN}`;
  await sembrarCuentasDeZernio();
  const c = await api("/api/settings/instagram", {
    method: "PUT",
    body: JSON.stringify({
      source: "zernio",
      igUserId: "ig-user-despacho",
      accountRef: CUENTA,
      token: "zernio-key-demo",
      webhookSecret: SECRETO,
    }),
  });
  ok("perfil de Instagram conectado por Zernio (zernio-mock)", c.res.ok, JSON.stringify(c.json));
  if (!c.res.ok) return;
  const texto = `hola por Instagram ${MARCA}`;
  const cuerpo = JSON.stringify({
    id: `evt-${RUN}`,
    event: "message.received",
    message: {
      id: `zmsg-ig-${RUN}`,
      conversationId: `zconv-ig-${RUN}`,
      direction: "incoming",
      text: texto,
      sender: { id: igsid, name: `Ivana Insta ${MARCA}`, username: "ivana" },
    },
    account: { id: CUENTA, platform: "instagram" },
  });
  const wh = await fetch(`${BASE}/api/webhooks/ig/${VERIFY_TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zernio-signature": createHmac("sha256", SECRETO).update(cuerpo).digest("hex"),
    },
    body: cuerpo,
  });
  ok("el webhook de Instagram respondió 200", wh.status === 200, String(wh.status));
  const conv = await hasta(async () =>
    (await conversaciones()).find((x) => x.channel === "instagram" && x.preview?.includes(MARCA))
  );
  const llego = conv ? await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000) : null;
  ok(
    "despacho con canal instagram e identidad ig:",
    llego?.evento.conversation.channel === "instagram" &&
      llego?.evento.contact.identity === `ig:${igsid}` &&
      llego?.evento.messages[0]?.text === texto &&
      llego?.firmaOk === true,
    JSON.stringify({ c: llego?.evento.conversation.channel, i: llego?.evento.contact.identity })
  );
  ok(
    "y el evento no dice por qué proveedor entró",
    Boolean(llego) && !llego.crudo.toLowerCase().includes("zernio"),
  );

  await tiktok(cerebro);
}

/** 022 — O TikTok entra pelo Zernio e é despachado como os demais, com sua janela. */
async function tiktok(cerebro) {
  if (!CHANNELS.includes("tiktok")) {
    console.log("  SKIP TikTok: CHANNELS no lo incluye");
    return;
  }
  console.log("\n== 022·AC8: TikTok se despacha con su canal y su ventana de 48 h ==");
  const CUENTA = "zernio-tt-despacho";
  const SECRETO = "secreto-del-webhook-de-zernio";
  const sender = `tt-despacho-${RUN}`;
  await sembrarCuentasDeZernio();
  const c = await api("/api/settings/tiktok", {
    method: "PUT",
    body: JSON.stringify({ accountRef: CUENTA, token: "zernio-key-demo", webhookSecret: SECRETO }),
  });
  ok("cuenta de TikTok conectada por Zernio (zernio-mock)", c.res.ok, JSON.stringify(c.json));
  if (!c.res.ok) return;
  const texto = `hola por TikTok ${MARCA}`;
  const hilo = `zconv-tt-${RUN}`;
  const cuerpo = JSON.stringify({
    id: `evt-tt-${RUN}`,
    event: "message.received",
    message: {
      id: `zmsg-tt-${RUN}`,
      conversationId: hilo,
      platform: "tiktok",
      direction: "incoming",
      text: texto,
      sender: { id: sender, name: `Tadeo Tok ${MARCA}`, username: "tadeo" },
    },
    conversation: { id: hilo },
    account: { id: CUENTA, accountId: CUENTA, platform: "tiktok" },
  });
  const t0 = Date.now();
  const wh = await fetch(`${BASE}/api/webhooks/tiktok/${VERIFY_TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zernio-signature": createHmac("sha256", SECRETO).update(cuerpo).digest("hex"),
    },
    body: cuerpo,
  });
  ok("el webhook de TikTok respondió 200", wh.status === 200, String(wh.status));
  const conv = await hasta(async () =>
    (await conversaciones()).find((x) => x.channel === "tiktok" && x.preview?.includes(MARCA))
  );
  const llego = conv ? await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000) : null;
  ok(
    "despacho con canal tiktok e identidad tt:",
    llego?.evento.conversation.channel === "tiktok" &&
      llego?.evento.contact.identity === `tt:${sender}` &&
      llego?.evento.messages[0]?.text === texto &&
      llego?.firmaOk === true,
    JSON.stringify({ c: llego?.evento.conversation.channel, i: llego?.evento.contact.identity })
  );
  const vence = Date.parse(llego?.evento.conversation.windowExpiresAt ?? "");
  ok(
    "windowExpiresAt cae a 48 h del mensaje, no a 24",
    Math.abs(vence - t0 - 48 * 3600_000) < 5 * 60_000,
    `${((vence - t0) / 3600_000).toFixed(2)} h`
  );
  if (llego) {
    const r = await bot("/api/bot/messages", {
      method: "POST",
      body: JSON.stringify({ conversationId: conv.id, text: `claro, por TikTok ${MARCA}` }),
    });
    ok("el cerebro contesta por el mismo /api/bot/messages", r.res.ok, JSON.stringify(r.json));
  }
}

// ---------------------------------------------------------------------------
// História 3 — quem responde
// ---------------------------------------------------------------------------

async function pausas(cerebro) {
  console.log("\n== AC11: una conversación en pausa no se despacha ==");
  const nombre = `Eli Pausa ${MARCA}`;
  await entranteWa(telefono(5), nombre, `antes de la pausa ${MARCA}`);
  const conv = await convDe(nombre);
  if (!conv) return ok("la conversación existe", false);
  await hasta(() => cerebro.de(conv.id)[0], COALESCE + 12000);
  ok("el primer turno sí se despachó", cerebro.de(conv.id).length === 1);

  const pausa = await api(`/api/conversations/${conv.id}`, {
    method: "PATCH",
    body: JSON.stringify({ aiEnabled: false }),
  });
  ok("el operador pausa la IA de esa conversación", pausa.res.ok);
  await entranteWa(telefono(5), nombre, `ya en pausa ${MARCA}`);
  await sleep(TRAS_LA_VENTANA);
  ok("el mensaje en pausa no llegó al cerebro", cerebro.de(conv.id).length === 1, String(cerebro.de(conv.id).length));
  ok(
    "pero sí está en la bandeja",
    (await mensajesDe(conv.id)).some((m) => m.text === `ya en pausa ${MARCA}`)
  );

  console.log("\n== AC11: pausar DURANTE la ventana descarta el turno, sin caer a humano ==");
  const nombre2 = `Fer Ventana ${MARCA}`;
  await entranteWa(telefono(6), nombre2, `primer turno ${MARCA}`);
  const conv2 = await convDe(nombre2);
  if (!conv2) return ok("la conversación existe", false);
  await hasta(() => cerebro.de(conv2.id)[0], COALESCE + 12000);
  await entranteWa(telefono(6), nombre2, `me arrepentí ${MARCA}`);
  // A ingestão roda depois de responder o webhook: aguarda-se que o
  // turno esteja ENFILEIRADO para pausar com ele dentro da sua janela. Pausar antes
  // testaria outra coisa (que não entra na fila), não que é descartado.
  const encolado = await hasta(
    async () => (await estadoCerebro())?.dispatch?.pending === 1,
    COALESCE,
    40
  );
  ok("el segundo turno está encolado, esperando su ventana", Boolean(encolado));
  const apagar = await api(`/api/conversations/${conv2.id}`, {
    method: "PATCH",
    body: JSON.stringify({ aiEnabled: false }),
  });
  /**
   * À parte, e antes: se a IA não chegou a desligar DENTRO da janela, o
   * despacho sai —como deve— e a verificação abaixo ficaria vermelha por
   * algo que fez o roteiro, não o produto (cloud #116).
   */
  ok(
    "el operador apaga la IA con la ventana todavía abierta",
    apagar.res.ok && cerebro.de(conv2.id).length === 1,
    `PATCH ${apagar.res.status}; el cerebro llevaba ${cerebro.de(conv2.id).length}`
  );
  await sleep(TRAS_LA_VENTANA);
  ok(
    "el turno encolado no se entregó",
    cerebro.de(conv2.id).length === 1,
    // De quem era: um despacho a mais não se pode atribuir sem isto.
    JSON.stringify(cerebro.de(conv2.id).map((r) => ({ id: r.evento?.dispatchId, textos: r.evento?.messages?.map((m) => m.text) })))
  );
  const despues = (await conversaciones()).find((c) => c.id === conv2.id);
  ok(
    "y la conversación NO quedó traspasada por error: la pausó una persona",
    despues?.handoffReason !== "error",
    JSON.stringify({ handoffAt: despues?.handoffAt, reason: despues?.handoffReason })
  );
  ok("no queda nada en espera", (await estadoCerebro())?.dispatch?.pending === 0);
}

async function laboratorio(cerebro) {
  console.log("\n== AC13: el Laboratorio no se despacha ==");
  const total = cerebro.estado.recibidos.length;
  const run = await api("/api/lab/runs", { method: "POST" });
  if (!run.res.ok) {
    console.log(`  SKIP no se pudo iniciar una corrida (${run.res.status}): ${JSON.stringify(run.json)}`);
    return;
  }
  const id = run.json?.runId ?? run.json?.id;
  const fin = await hasta(
    async () => {
      const r = (await api(`/api/lab/runs/${id}`)).json;
      const st = r?.run?.status ?? r?.status;
      return st && st !== "running" ? st : null;
    },
    180000,
    1000
  );
  ok("la corrida del Laboratorio terminó (con el agente incluido)", fin === "done", String(fin));
  await sleep(TRAS_LA_VENTANA);
  const nuevos = cerebro.estado.recibidos.slice(total);
  ok(
    "ningún cliente simulado llegó al cerebro",
    nuevos.length === 0,
    JSON.stringify(nuevos.map((r) => r.evento?.contact?.displayName))
  );
}

// ---------------------------------------------------------------------------
// História 2 — o cérebro falha
// ---------------------------------------------------------------------------

async function cerebroCaido(cerebro) {
  console.log("\n== AC6/AC7: el cerebro responde 500 → tres intentos y a un humano ==");
  const nombre = `Gabi Caído ${MARCA}`;
  cerebro.estado.modo = "500";
  const t0 = Date.now();
  await entranteWa(telefono(7), nombre, `¿hay alguien? ${MARCA}`);
  const conv = await convDe(nombre);
  ok("el mensaje está en la bandeja aunque el cerebro esté caído", Boolean(conv));
  if (!conv) return;

  const traspaso = await hasta(
    async () => (await conversaciones()).find((c) => c.id === conv.id && c.handoffAt),
    COALESCE + 30000
  );
  ok("la conversación pasó a un humano", Boolean(traspaso), `${Date.now() - t0} ms`);
  ok(
    "con la IA en pausa y motivo error",
    traspaso?.aiEnabled === false && traspaso?.handoffReason === "error",
    JSON.stringify({ ai: traspaso?.aiEnabled, reason: traspaso?.handoffReason })
  );
  const intentos = cerebro.de(conv.id);
  ok("fueron tres intentos", intentos.length === 3, String(intentos.length));
  ok(
    "del MISMO despacho (el dispatchId es la clave de idempotencia)",
    new Set(intentos.map((r) => r.evento.dispatchId)).size === 1
  );
  ok("todos firmados", intentos.every((r) => r.firmaOk));
  ok(
    "con espera creciente entre ellos (~1 s y ~4 s)",
    intentos.length === 3 &&
      intentos[1].at - intentos[0].at >= 900 &&
      intentos[2].at - intentos[1].at >= 3600,
    intentos.length === 3 ? `${intentos[1].at - intentos[0].at} ms, ${intentos[2].at - intentos[1].at} ms` : ""
  );
  await sleep(3000);
  ok("y no hay un cuarto", cerebro.de(conv.id).length === 3);

  const st = await estadoCerebro();
  ok(
    "«Quién responde» enseña el fallo con su motivo",
    st?.dispatch?.lastFailure?.detail?.includes("500") === true,
    JSON.stringify(st?.dispatch)
  );

  await entranteWa(telefono(7), nombre, `sigo aquí ${MARCA}`);
  await sleep(TRAS_LA_VENTANA);
  ok(
    "ya con un humano, los mensajes nuevos no se despachan",
    cerebro.de(conv.id).length === 3,
    String(cerebro.de(conv.id).length)
  );

  console.log("\n== AC8: un 4xx no se reintenta ==");
  const nombre2 = `Hugo Rechazo ${MARCA}`;
  cerebro.estado.modo = "422";
  await entranteWa(telefono(8), nombre2, `esto no lo entiendes ${MARCA}`);
  const conv2 = await convDe(nombre2);
  if (!conv2) return ok("la conversación existe", false);
  const traspaso2 = await hasta(
    async () => (await conversaciones()).find((c) => c.id === conv2.id && c.handoffAt),
    COALESCE + 15000
  );
  ok("cae a un humano", traspaso2?.handoffReason === "error", JSON.stringify(traspaso2?.handoffReason));
  await sleep(6000);
  ok("con un solo intento", cerebro.de(conv2.id).length === 1, String(cerebro.de(conv2.id).length));

  console.log("\n== AC6: el cerebro ni siquiera acepta la conexión ==");
  const nombre3 = `Iris Apagado ${MARCA}`;
  cerebro.estado.modo = "ok";
  await cerebro.apagar();
  try {
    await entranteWa(telefono(9), nombre3, `¿siguen ahí? ${MARCA}`);
    const conv3 = await convDe(nombre3);
    ok("el mensaje está en la bandeja", Boolean(conv3));
    const traspaso3 = conv3
      ? await hasta(
          async () => (await conversaciones()).find((c) => c.id === conv3.id && c.handoffAt),
          COALESCE + 30000
        )
      : null;
    ok("cae a un humano", traspaso3?.handoffReason === "error");
    const st3 = await estadoCerebro();
    ok(
      "el motivo dice que no se pudo conectar, sin URL ni llave",
      st3?.dispatch?.lastFailure?.detail === "no se pudo conectar con el cerebro",
      JSON.stringify(st3?.dispatch?.lastFailure)
    );
  } finally {
    await cerebro.encender();
  }

  console.log("\n== El cerebro vuelve: el siguiente cliente se atiende ==");
  const nombre4 = `Juan Vuelve ${MARCA}`;
  await entranteWa(telefono(10), nombre4, `hola de nuevo ${MARCA}`);
  const conv4 = await convDe(nombre4);
  const llego = conv4 ? await hasta(() => cerebro.de(conv4.id)[0], COALESCE + 12000) : null;
  ok("un cliente nuevo sí se despacha", Boolean(llego) && llego.firmaOk);
  const st4 = await hasta(async () => {
    const s = await estadoCerebro();
    const d = s?.dispatch;
    return d?.lastDeliveredAt && d?.lastFailure && Date.parse(d.lastDeliveredAt) > Date.parse(d.lastFailure.at)
      ? s
      : null;
  }, 8000);
  ok("y la última entrega ya es posterior al último fallo", Boolean(st4));
}

// ---------------------------------------------------------------------------
// História 4 — aparece em «Quem responde»
// ---------------------------------------------------------------------------

async function tarjeta(cerebro, url) {
  console.log("\n== AC14–AC16: «Quién responde» ==");
  const st = await estadoCerebro();
  const d = st?.dispatch ?? {};
  ok(
    "dispatch: activo, con host y sin problema",
    d.active === true && d.host === url.host && d.problem === null,
    JSON.stringify(d)
  );
  ok(
    "con la última entrega y sin turnos en espera",
    typeof d.lastDeliveredAt === "string" && d.pending === 0,
    JSON.stringify(d)
  );
  const crudo = JSON.stringify(st);
  ok(
    "solo el host: ni la ruta de la URL ni la llave",
    !crudo.includes(url.pathname) && !crudo.includes(BOT_KEY)
  );
  ok(
    "las llaves de antes siguen ahí",
    typeof st?.embedded?.answering === "boolean" &&
      typeof st?.external?.active === "boolean" &&
      "warning" in (st ?? {}) &&
      "lastSeenAt" in (st?.external ?? {})
  );
  ok("el cerebro cuenta como el que contesta", st?.external?.active === true);
  const anon = await fetch(`${BASE}/api/agent/brain-status`);
  ok("sin sesión → 401", anon.status === 401, String(anon.status));
  console.log(`\n  (el cerebro de prueba recibió ${cerebro.estado.recibidos.length} peticiones en total)`);
}

// ---------------------------------------------------------------------------
// 025 — Sem cérebro externo: o agente incluído
// ---------------------------------------------------------------------------

async function guionIncluido() {
  console.log("== Setup: operador, WhatsApp y agente incluido ENCENDIDO ==");
  await preparar();
  await iaMock("?reset=1&demoraMs=0");
  const st = await estadoCerebro();
  ok(
    "no hay despacho: contesta el agente incluido",
    st?.dispatch?.active === false && st?.embedded?.answering === true,
    JSON.stringify({ dispatch: st?.dispatch, embedded: st?.embedded })
  );
  if (st?.embedded?.answering !== true) {
    console.error(
      "\nEl agente incluido no puede contestar: revisa OPENROUTER_BASE_URL → ai-mock, OPENROUTER_API_TOKEN y OPENROUTER_MODEL."
    );
    return;
  }
  try {
    await incluidoEnVuelo();
    await incluidoPersona();
  } finally {
    await iaMock("?reset=1&demoraMs=0");
  }
  ok(
    "y nada de esto pasó por el outbox del despacho",
    (await estadoCerebro())?.dispatch?.pending === 0
  );
}

async function incluidoEnVuelo() {
  console.log("\n== 025·AC6: el agente incluido atiende el mensaje que entra mientras piensa ==");
  /**
   * O turno se repete desde sempre quando entra algo no meio (`pending`).
   * O que falhava era a ORDEM: pela hora de chegada, a segunda mensagem vai
   * ANTES da resposta à primeira; lido assim, o modelo vê um fio que
   * termina na sua própria resposta e o dá por respondido.
   *
   * O modelo de teste demora 5 s para responder: é o buraco em que entra a
   * segunda mensagem. Se mesmo assim não entrar a tempo (na primeira vez o `next
   * dev` compila rotas), o caso se repete com outro contato.
   */
  const DEMORA_MS = 5000;
  const caso = await conLaVentanaAbierta(async (i) => {
    const nombre = `Nora Incluida ${i} ${MARCA}`;
    const uno = `¿tienen taladros? ${i} ${MARCA}`;
    const dos = `¿mandan a Celaya? ${i} ${MARCA}`;
    await iaMock(`?demoraMs=${DEMORA_MS}`);
    await entranteWa(telefono(40 + i), nombre, uno);
    const conv = await convDe(nombre);
    if (!conv) return null;
    const primera = await hasta(async () => (await peticionesCon(uno))[0], COALESCE + 12000, 100);
    if (primera?.mensajes.at(-1)?.content !== uno) return null;

    await entranteWa(telefono(40 + i), nombre, dos);
    const segundo = await entranteGuardado(conv.id, dos);
    const contestaEn = Date.parse(primera.at) + DEMORA_MS;
    // Se o modelo já respondeu, a segunda mensagem não entrou «no meio»: seria
    // um turno normal e o caso passaria sem provar nada.
    if (!segundo || Date.now() > contestaEn - 300) {
      await iaMock("?demoraMs=0");
      return null;
    }
    return { conv, uno, dos };
  });
  ok("el segundo mensaje entró con el modelo todavía pensando en el primero", Boolean(caso));
  if (!caso) return;
  const { conv, uno, dos } = caso;

  // O segundo turno já não precisa ir devagar.
  await iaMock("?demoraMs=0");
  const salientes = await hasta(
    async () => {
      const out = (await mensajesDe(conv.id)).filter((m) => m.direction === "out");
      return out.length >= 2 ? out : null;
    },
    DEMORA_MS + COALESCE + 12000
  );

  // Que não entre em loop: aguarda-se outra janela antes de contar.
  await sleep(TRAS_LA_VENTANA);
  const peticiones = await peticionesCon(uno);
  ok(
    "el agente gasta UN turno más: ni se queda callado ni entra en bucle",
    peticiones.length === 2,
    `turnos del modelo: ${peticiones.length} — con 1, el segundo mensaje se quedó sin atender`
  );

  console.log("\n== 025·AC7: y lo lee DESPUÉS de su propia respuesta ==");
  const charla = (peticiones[1]?.mensajes ?? []).map((m) => `${m.role}: ${m.content}`);
  ok(
    "cliente, agente, cliente",
    charla.length === 3 &&
      charla[0] === `user: ${uno}` &&
      charla[1].startsWith("assistant: ") &&
      charla[2] === `user: ${dos}`,
    `leyó: ${JSON.stringify(charla)}`
  );

  console.log("\n== 025·AC8: el cliente recibe las dos respuestas, cada una a lo suyo ==");
  const finales = (await mensajesDe(conv.id)).filter((m) => m.direction === "out");
  ok(
    "dos salientes: uno sobre los taladros y otro sobre el envío",
    finales.length === 2 &&
      finales.some((m) => m.text?.includes(uno)) &&
      finales.some((m) => m.text?.includes(dos)),
    JSON.stringify((salientes ?? finales).map((m) => m.text))
  );
}

async function incluidoPersona() {
  console.log("\n== 025·AC5b: si una persona contesta dentro de la ventana, el agente incluido no contesta encima ==");
  await iaMock("?demoraMs=0");
  const caso = await conLaVentanaAbierta(async (i) => {
    const nombre = `Omar Atendido ${i} ${MARCA}`;
    const texto = `¿a qué hora cierran? ${i} ${MARCA}`;
    await entranteWa(telefono(50 + i), nombre, texto);
    const conv = await convDe(nombre);
    if (!conv) return null;
    const envio = await aMano(conv.id, `Cerramos a las 7 ${i} ${MARCA}`);
    if (!envio.res.ok || (await peticionesCon(texto)).length !== 0) return null;
    return { conv, nombre, texto, i };
  });
  ok("una persona contesta con la ventana todavía abierta", Boolean(caso));
  if (!caso) return;
  const { conv, nombre, texto, i } = caso;

  await sleep(TRAS_LA_VENTANA);
  ok(
    "el modelo no gastó un turno en ese mensaje",
    (await peticionesCon(texto)).length === 0,
    String((await peticionesCon(texto)).length)
  );
  const salientes = (await mensajesDe(conv.id)).filter((m) => m.direction === "out");
  ok(
    "el único saliente es el de la persona",
    salientes.length === 1 && salientes[0].text === `Cerramos a las 7 ${i} ${MARCA}`,
    JSON.stringify(salientes.map((m) => m.text))
  );
  const despues = (await conversaciones()).find((c) => c.id === conv.id);
  ok(
    "la IA de la conversación sigue encendida",
    despues?.aiEnabled === true && !despues?.handoffAt,
    JSON.stringify({ ai: despues?.aiEnabled, handoffAt: despues?.handoffAt })
  );

  const otro = `¿y los domingos? ${i} ${MARCA}`;
  await entranteWa(telefono(50 + i), nombre, otro);
  const respuesta = await hasta(
    async () =>
      (await mensajesDe(conv.id)).find((m) => m.direction === "out" && m.text?.includes(otro)),
    COALESCE + 12000
  );
  ok("el siguiente mensaje del cliente sí lo contesta el agente", Boolean(respuesta));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
