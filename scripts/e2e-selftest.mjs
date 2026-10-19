/**
 * Self-test E2E de comportamento — conduz o app real em localhost com os
 * mocks (wa-mock + ai-mock) pelas superfícies de usuário, em vez de passar o
 * roteiro ao humano. Cobre tests/e2e/us-bsuid.md e tests/e2e/us-bot-api.md.
 *
 * Uso:
 *   1) app rodando com WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      BOT_API_KEY configurada e BD migrada
 *   2) node --env-file=.env scripts/e2e-selftest.mjs
 *
 * Sai com código 1 se alguma verificação falhar (apto para CI ou para o gate prévio
 * a declarar "Pronto").
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;

let cookie = "";
let failures = 0;
let checks = 0;

function ok(name, cond, extra = "") {
  checks++;
  if (cond) {
    console.log(`  OK  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      // O Better Auth valida Origin (CSRF) nos endpoints de auth.
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  let json = null;
  try {
    json = await res.clone().json();
  } catch {}
  return { res, json };
}

function bot(path, opts = {}) {
  return api(path, {
    ...opts,
    headers: { "x-api-key": BOT_KEY ?? "", ...(opts.headers ?? {}) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera até que algo ACONTEÇA, em vez de dormir um pouco e confiar.
 *
 * Um `sleep` fixo transforma qualquer lentidão —a primeira compilação de uma
 * rota no `next dev`, por exemplo— numa falha que não significa nada. E se
 * ele for generoso, alonga o roteiro inteiro para todos.
 */
async function hasta(cond, ms = 15000, paso = 400) {
  const fin = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > fin) return false;
    await sleep(paso);
  }
}
const PN = "PN-E2E-1";

async function main() {
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.error(
      "BOT_API_KEY ausente o corta (<16): los checks de /api/bot/* no pueden correr."
    );
    process.exit(1);
  }

  console.log("== Setup: registro/login + conexión WhatsApp ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    // Nova execução: o cadastro se fecha após a primeira organização.
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));

  await guiaChecks();

  const conn = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({
      wabaId: "WABA-E2E",
      phoneNumberId: PN,
      token: "tok-e2e",
    }),
  });
  ok(
    "conexión WhatsApp guardada (vía wa-mock)",
    conn.res.ok,
    JSON.stringify(conn.json)
  );
  await api("/api/dev/wa-mock/outbox", { method: "DELETE" });

  await overrideChecks();

  console.log("\n== us-bsuid: inbound sin wa_id ==");
  const inb1 = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: "bsu_e2e_1",
      name: "Dueña Dental",
      text: "hola, vi su anuncio",
      waMessageId: "wamid.e2e.bsuid.1",
    }),
  });
  ok("inbound BSUID entregado", inb1.res.ok, JSON.stringify(inb1.json));
  await sleep(1200);

  let convs = (await api("/api/conversations")).json?.conversations ?? [];
  const bsuidConv = convs.find((c) => c.contact.name === "Dueña Dental");
  ok("conversación con nombre de perfil (no el BSUID crudo)", !!bsuidConv);
  ok("contacto BSUID sin teléfono", bsuidConv?.contact.phone === null);

  const reply = await api(`/api/conversations/${bsuidConv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "¡Hola! Te atendemos enseguida" }),
  });
  ok("respuesta a contacto BSUID enviable", reply.res.ok, JSON.stringify(reply.json));

  const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  /**
   * Esta checagem fixava o comportamento ERRADO: afirmava que o BSUID viaja em `to`.
   * E passava, porque o mock aceitava qualquer coisa ali
   * — enquanto a Meta respondia 131026 em produção. Um teste verde sobre um
   * mock permissivo é pior que não tê-lo: convence do contrário.
   */
  ok(
    "el destinatario del envío es el BSUID, en `recipient`",
    outbox.some((o) => o.recipient === "bsu_e2e_1" && !o.to),
    JSON.stringify(outbox.map((o) => ({ to: o.to, recipient: o.recipient })))
  );

  // Idempotência: reentrega do mesmo wa_message_id
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: "bsu_e2e_1",
      name: "Dueña Dental",
      text: "hola, vi su anuncio",
      waMessageId: "wamid.e2e.bsuid.1",
    }),
  });
  await sleep(800);
  const msgs =
    (await api(`/api/conversations/${bsuidConv?.id}/messages`)).json?.messages ??
    [];
  const inCount = msgs.filter((m) => m.direction === "in").length;
  ok("webhook duplicado no duplica mensajes", inCount === 1, `in=${inCount}`);

  console.log("\n== us-bsuid: a un contacto sin teléfono se le puede responder ==");
  {
    /**
     * O caso de produção que deixou mudo o agente de um membro.
     *
     * A Meta omite o telefone quando coincidem TRÊS condições: o usuário
     * ativou seu nome de usuário, não houve interação com esse número de
     * empresa em 30 dias, e ele não está na agenda. Então só chega o
     * BSUID — e é preciso respondê-lo por `recipient`, não por `to`: em `to`
     * a Meta espera um telefone e devolve 131026, que na bandeja se lê
     * como se o número do cliente não existisse.
     */
    const conv = bsuidConv;
    if (!conv) {
      ok("hay conversacion BSUID para responder", false, "no aparecio");
    } else {
      const envio = await api(`/api/conversations/${conv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: "respuesta a un BSUID" }),
      });
      ok("se le PUEDE responder (antes: Meta 131026)", envio.res.ok,
        `status=${envio.res.status} ${JSON.stringify(envio.json)}`);

      const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
      const salida = outbox[outbox.length - 1];
      ok("y el BSUID viaja en `recipient`, nunca en `to`",
        salida?.recipient === "bsu_e2e_1" && !salida?.to,
        `to=${JSON.stringify(salida?.to)} recipient=${JSON.stringify(salida?.recipient)}`);
    }
  }

  console.log("\n== us-bsuid: reconciliación 521/52 ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: "5215550001234",
      name: "Kevin MX",
      text: "uno",
    }),
  });
  await sleep(800);
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: "525550001234", text: "dos" }),
  });
  await sleep(800);
  const contacts =
    (await api("/api/contacts?q=Kevin%20MX")).json?.contacts ?? [];
  ok(
    "521 y 52 resuelven a UN solo contacto",
    contacts.length === 1,
    `n=${contacts.length}`
  );

  const mxConv = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Kevin MX"
  );
  ok("el contacto reconciliado conserva su conversación", !!mxConv);

  // Issue #35: um destinatário argentino chega como `549` + 10 dígitos e é preciso
  // ENVIAR-LHE sem o 9. A identidade, por sua vez, conserva o que a Meta
  // informa: se fosse reescrita, deixaria de casar com o `wa_id` de cada
  // webhook e o contato se partiria em dois.
  console.log("\n== us-bsuid: destinatario argentino (549 → 54) ==");
  const AR_REPORTADO = "5491122334455";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: AR_REPORTADO,
      name: "Lead AR",
      text: "hola desde Argentina",
      waMessageId: "wamid.e2e.ar.1",
    }),
  });
  await sleep(1200);
  const convAr = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Lead AR"
  );
  ok("la conversación argentina se creó", Boolean(convAr));
  ok(
    "la identidad guardada conserva el 9 que reporta Meta",
    convAr?.contact.phone === AR_REPORTADO,
    `phone=${convAr?.contact.phone}`
  );

  if (convAr) {
    // Conta-se o que já havia em vez de esvaziar a caixa de saída: o DELETE do
    // wa-mock reinicia seu contador de wa_message_id, e numa NOVA EXECUÇÃO isso
    // colide com as mensagens que já estão no banco (unique) e derruba o envio
    // com um 500 que não tem nada a ver com o que está sendo testado.
    const outboxAntes =
      ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
    const envioAr = await api(`/api/conversations/${convAr.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "respuesta a Argentina" }),
    });
    ok("el mensaje a Argentina se envía", envioAr.res.ok, `status=${envioAr.res.status}`);
    const outboxAr = (
      (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []
    ).slice(outboxAntes);
    ok(
      "por el cable viaja SIN el 9 (lo que la lista de permitidos acepta)",
      outboxAr.some((o) => o.to === "541122334455"),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
    ok(
      "…y nunca con el 9, que es lo que devolvía 131030",
      !outboxAr.some((o) => o.to === AR_REPORTADO),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
  }

  console.log("\n== #51: el nombre del contacto sigue al perfil, salvo si lo escribió alguien ==");
  {
    const N = Date.now().toString().slice(-6);
    const TEL = `5214627${N}`;
    const decir = (nombre, i) =>
      api("/api/dev/wa-mock/inbound", {
        method: "POST",
        body: JSON.stringify({
          phoneNumberId: PN,
          from: TEL,
          name: nombre,
          text: `hola ${i}`,
          waMessageId: `wamid.e2e.51.${N}.${i}`,
        }),
      });
    const contactoDe = async () => {
      const cs = (await api("/api/contacts")).json?.contacts ?? [];
      return cs.find((c) => c.phone === `524627${N}`) ?? null;
    };

    await decir("Federico", 1);
    await hasta(async () => Boolean(await contactoDe()));
    const creado = await contactoDe();
    ok("el contacto nace con el nombre del perfil", creado?.name === "Federico",
      `nombre: ${creado?.name}`);

    // O caso relatado: muda seu nome no WhatsApp e volta a escrever.
    await decir("Federicoso", 2);
    await hasta(async () => (await contactoDe())?.name === "Federicoso");
    ok("cambiar el nombre de WhatsApp actualiza el contacto",
      (await contactoDe())?.name === "Federicoso",
      `nombre: ${(await contactoDe())?.name}`);

    // E o que NÃO pode acontecer: que o perfil atropele o que uma pessoa escreveu.
    const editado = await api(`/api/contacts/${creado?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Fede - obra Polanco" }),
    });
    ok("el operador puede renombrar a mano", editado.res.ok, editado.texto);

    await decir("Federicoso", 3);
    await sleep(1500);
    ok("y WhatsApp ya no pisa ese nombre",
      (await contactoDe())?.name === "Fede - obra Polanco",
      `nombre: ${(await contactoDe())?.name}`);
  }

  console.log("\n== us-bot-api: autorización ==");
  const noKey = await api("/api/bot/media/media123");
  ok("media sin API key → 401", noKey.res.status === 401);
  const badKey = await api("/api/bot/media/media123", {
    headers: { "x-api-key": "x".repeat(BOT_KEY.length) },
  });
  ok("media con API key equivocada → 401", badKey.res.status === 401);
  const resetNoKey = await api("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: mxConv?.id }),
  });
  ok("reset sin API key → 401", resetNoKey.res.status === 401);

  console.log("\n== us-bot-api: typing + leído ==");
  const convId = mxConv?.id;
  const outboxBeforeTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const typ = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/typing → ok:true (leído + escribiendo…)",
    typ.res.ok && typ.json?.ok === true,
    JSON.stringify(typ.json)
  );
  const outboxAfterTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "typing NO contamina el outbox",
    outboxAfterTyping === outboxBeforeTyping,
    `antes=${outboxBeforeTyping} después=${outboxAfterTyping}`
  );

  const typ404 = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe" }),
  });
  ok("typing con conversación inexistente → 404", typ404.res.status === 404);

  console.log("\n== us-bot-api: media proxy ==");
  const med = await bot("/api/bot/media/media123");
  const medBytes = med.res.ok ? await med.res.arrayBuffer() : new ArrayBuffer(0);
  ok(
    "GET /api/bot/media/{id} → binario con content-type",
    med.res.ok &&
      medBytes.byteLength > 0 &&
      (med.res.headers.get("content-type") ?? "").includes("image"),
    `status=${med.res.status} bytes=${medBytes.byteLength}`
  );
  const medBad = await bot("/api/bot/media/no-es-media");
  ok(
    "mediaId que Graph no reconoce → error tipado, no 500",
    medBad.res.status === 404 || medBad.res.status === 502,
    `status=${medBad.res.status}`
  );

  console.log("\n== us-bot-api: perfil del agente + knowledge base ==");
  const profNoKey = await api("/api/bot/profile");
  ok("perfil sin API key → 401", profNoKey.res.status === 401);

  const putProf = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({
      name: "Sofi",
      tone: "cálido y directo",
      instructions: "Vendemos limpiezas dentales.",
      escalationRules: "Urgencias de dolor → humano.",
      greeting: "¡Hola! Soy Sofi",
      enabled: false,
    }),
  });
  ok("perfil guardado desde la pantalla Agente", putProf.res.ok);
  const kbQa = await api("/api/kb", {
    method: "POST",
    body: JSON.stringify({
      kind: "qa",
      question: "¿Cuánto cuesta?",
      answer: "$800.",
    }),
  });
  ok("entrada de KB creada desde la pantalla", kbQa.res.ok, JSON.stringify(kbQa.json));

  const prof = await bot("/api/bot/profile");
  ok(
    "GET /api/bot/profile → 200 con el perfil de la pantalla",
    prof.res.ok && prof.json?.profile?.name === "Sofi",
    JSON.stringify(prof.json?.profile)
  );
  ok(
    "el knowledge base viaja renderizado (P:/R:)",
    typeof prof.json?.kb === "string" && prof.json.kb.includes("P: ¿Cuánto cuesta?"),
    JSON.stringify(prof.json?.kb)
  );
  ok(
    "`enabled` NO viaja: gobierna la IA in-process, no al bot externo",
    prof.json?.profile && !("enabled" in prof.json.profile)
  );
  ok("`resources` presente y vacío", Array.isArray(prof.json?.resources));

  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ tone: "seco y breve" }),
  });
  const profAgain = await bot("/api/bot/profile");
  ok(
    "editar el tono se refleja al instante (sin caché)",
    profAgain.json?.profile?.tone === "seco y breve",
    JSON.stringify(profAgain.json?.profile?.tone)
  );

  console.log("\n== us-bot-api: contexto conversacional ==");
  const ctxNoKey = await api(`/api/bot/context?conversationId=${convId}`);
  ok("contexto sin API key → 401", ctxNoKey.res.status === 401);

  const ctx = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "GET /api/bot/context por conversationId → 200",
    ctx.res.ok && ctx.json?.conversation?.id === convId,
    JSON.stringify(ctx.json?.conversation)
  );
  ok(
    "trae la identidad estable del contacto (no solo el teléfono)",
    typeof ctx.json?.contact?.waIdentity === "string" &&
      ctx.json.contact.waIdentity.length > 0
  );
  ok(
    "trae la etapa del lead en el pipeline",
    typeof ctx.json?.lead?.stageName === "string",
    JSON.stringify(ctx.json?.lead)
  );
  ok(
    "la ventana de 24 h viaja abierta tras un entrante reciente",
    ctx.json?.conversation?.windowOpen === true &&
      ctx.json?.conversation?.windowRemainingMs > 0,
    JSON.stringify(ctx.json?.conversation)
  );

  // 015 — `booking` é aditivo e só existe com a agenda ligada. Um
  // cérebro o tolera ausente (não afirma nada sobre agendamentos); o que não pode
  // receber é um bloco vazio numa instância SEM agenda, porque o leria
  // como «este lead não tem agendamento».
  if (/^(on|1|true|si|sí|yes)$/i.test((process.env.AGENDA ?? "").trim())) {
    const b = ctx.json?.booking;
    ok(
      "con la agenda encendida el contexto trae `booking` (sin citas: las tres vacías)",
      typeof b?.timezone === "string" &&
        b.next === null &&
        b.unresolved === null &&
        b.lastClosed === null,
      JSON.stringify(b)
    );
  } else {
    ok(
      "con la agenda apagada el contexto NO trae `booking`, ni vacío",
      Boolean(ctx.json) && !("booking" in ctx.json),
      JSON.stringify(Object.keys(ctx.json ?? {}))
    );
  }

  const ctxByIdentity = await bot(
    `/api/bot/context?waIdentity=${encodeURIComponent(ctx.json.contact.waIdentity)}`
  );
  ok(
    "resolver por waIdentity da la MISMA conversación",
    ctxByIdentity.json?.conversation?.id === convId,
    JSON.stringify(ctxByIdentity.json?.conversation?.id)
  );

  const ctxSinArgs = await bot("/api/bot/context");
  ok("contexto sin waIdentity ni conversationId → 422", ctxSinArgs.res.status === 422);
  const ctx404 = await bot("/api/bot/context?conversationId=cv_no_existe");
  ok("contexto de una conversación inexistente → 404", ctx404.res.status === 404);

  console.log("\n== us-bot-api: ficha de calificación ==");
  const fichaNoKey = await api("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId, ficha: { rubro: "x" } }),
  });
  ok("ficha sin API key → 401", fichaNoKey.res.status === 401);

  const f1 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { rubro: "dentista", geo: "Querétaro", calificado: true },
    }),
  });
  ok(
    "PUT /api/bot/ficha → 200 con la ficha completa",
    f1.res.ok && f1.json?.ficha?.rubro === "dentista",
    JSON.stringify(f1.json)
  );
  ok(
    "las claves las pone el negocio: el CRM guarda lo que le manden",
    f1.json?.ficha?.geo === "Querétaro" && f1.json?.ficha?.calificado === true,
    JSON.stringify(f1.json?.ficha)
  );

  const ctxConFicha = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "la ficha viaja en el contexto del siguiente turno",
    ctxConFicha.json?.contact?.ficha?.rubro === "dentista",
    JSON.stringify(ctxConFicha.json?.contact?.ficha)
  );

  const f2 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { presupuesto: "20 mil", geo: null },
    }),
  });
  ok(
    "merge campo a campo: lo ausente se conserva",
    f2.json?.ficha?.rubro === "dentista" && f2.json?.ficha?.presupuesto === "20 mil",
    JSON.stringify(f2.json?.ficha)
  );
  ok(
    "null explícito borra la clave",
    f2.json?.ficha && !("geo" in f2.json.ficha),
    JSON.stringify(f2.json?.ficha)
  );

  const fBasura = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { anidado: { a: 1 }, vacío: "", bueno: "  sí  " },
    }),
  });
  ok(
    "lo que no se entiende se ignora sin 422 (no se le tiran datos al bot)",
    fBasura.res.ok &&
      fBasura.json?.ficha?.bueno === "sí" &&
      !("anidado" in fBasura.json.ficha) &&
      !("vacío" in fBasura.json.ficha),
    JSON.stringify(fBasura.json?.ficha)
  );

  const fNoConv = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: "cv_no_existe", ficha: { a: "b" } }),
  });
  ok("ficha de conversación inexistente → 404", fNoConv.res.status === 404);
  const fSinFicha = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok("cuerpo sin `ficha` → 422", fSinFicha.res.status === 422);

  console.log("\n== us-bot-api: el bot envía a través del CRM ==");
  const sendNoKey = await api("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "hola" }),
  });
  ok("envío sin API key → 401", sendNoKey.res.status === 401);

  const outboxBeforeBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const botSend = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "Hola, soy el bot." }),
  });
  ok(
    "POST /api/bot/messages → 200 con messageId",
    botSend.res.ok && typeof botSend.json?.messageId === "string",
    JSON.stringify(botSend.json)
  );
  const outboxAfterBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "el mensaje salió de verdad por el canal de WhatsApp",
    outboxAfterBot === outboxBeforeBot + 1,
    `antes=${outboxBeforeBot} después=${outboxAfterBot}`
  );
  const botMsg = ((await api(`/api/conversations/${convId}/messages`)).json
    ?.messages ?? []).find((m) => m.id === botSend.json?.messageId);
  ok(
    "queda en la bandeja marcado como IA (aiGenerated + origin=ai)",
    botMsg?.aiGenerated === true && botMsg?.origin === "ai",
    JSON.stringify({ aiGenerated: botMsg?.aiGenerated, origin: botMsg?.origin })
  );
  const sendNoConv = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", text: "hola" }),
  });
  ok("envío a conversación inexistente → 404", sendNoConv.res.status === 404);
  const sendVacio = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "" }),
  });
  ok("texto vacío → 422 (no se manda un mensaje en blanco)", sendVacio.res.status === 422);

  // Regressão: a hora da saída deve ser a mesma nas duas visões.
  // As colunas são `timestamp without time zone` e são preenchidas por dois caminhos
  // — `now()` dos `defaultNow()` (referencial da SESSÃO do BD) e `Date` vindo do
  // JS (referencial UTC, o que o Drizzle lê de volta). Se a sessão não estiver em UTC,
  // `message.created_at` (bolha do fio) se desloca de
  // `conversation.last_message_at` (lista) pelo offset do servidor do BD.
  console.log("\n== zona horaria: la misma hora en la lista y en el hilo ==");
  const convTz = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  const minutos = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 60000;
  ok(
    "el saliente trae la misma hora en el hilo y en la lista",
    convTz?.lastMessageAt !== undefined &&
      botMsg?.createdAt !== undefined &&
      minutos(convTz.lastMessageAt, botMsg.createdAt) < 5,
    JSON.stringify({
      hilo: botMsg?.createdAt,
      lista: convTz?.lastMessageAt,
    })
  );
  ok(
    "y esa hora es la de ahora, no la del huso del servidor de BD",
    botMsg?.createdAt !== undefined &&
      minutos(new Date().toISOString(), botMsg.createdAt) < 5,
    JSON.stringify({ hilo: botMsg?.createdAt, ahora: new Date().toISOString() })
  );

  console.log("\n== us-bot-api: el bot pide un humano ==");
  const hoNoKey = await api("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  ok("handoff sin API key → 401", hoNoKey.res.status === 401);

  const ho = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "hostilidad" }),
  });
  ok("POST /api/bot/handoff → 200", ho.res.ok && ho.json?.ok === true);
  await sleep(300);
  let convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "la conversación queda pausada y con su motivo",
    convTrasHandoff?.aiEnabled === false &&
      !!convTrasHandoff?.handoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      aiEnabled: convTrasHandoff?.aiEnabled,
      reason: convTrasHandoff?.handoffReason,
    })
  );
  const primerHandoffAt = convTrasHandoff?.handoffAt;

  const hoRepe = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "repetir el handoff es idempotente: no pisa la hora ni el motivo original",
    hoRepe.res.ok &&
      convTrasHandoff?.handoffAt === primerHandoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      antes: primerHandoffAt,
      ahora: convTrasHandoff?.handoffAt,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  const hoNoConv = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", reason: "cliente" }),
  });
  ok("handoff de conversación inexistente → 404", hoNoConv.res.status === 404);

  // O handoff jamais pode se perder por um motivo que não esteja no catálogo:
  // o bot continuaria falando com alguém que pediu um humano.
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoRaro = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "porque sí" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "un motivo fuera del catálogo NO tira el handoff (cae a 'modelo')",
    hoRaro.res.ok &&
      convTrasHandoff?.aiEnabled === false &&
      convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify({
      status: hoRaro.res.status,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoSinReason = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "sin motivo también pausa (cae a 'modelo')",
    hoSinReason.res.ok && convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify(convTrasHandoff?.handoffReason)
  );
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);

  console.log("\n== us-bot-api: IA pausada y reset ==");
  const pause = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    body: JSON.stringify({ aiEnabled: false }),
  });
  ok("IA pausada desde la bandeja", pause.res.ok, JSON.stringify(pause.json));

  const typPaused = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "typing con IA pausada → ok:false ai_paused (no toca Meta)",
    typPaused.res.ok &&
      typPaused.json?.ok === false &&
      typPaused.json?.reason === "ai_paused",
    JSON.stringify(typPaused.json)
  );

  const outboxBeforePaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const sendPaused = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "¿sigo yo?" }),
  });
  ok(
    "el bot NO habla sobre una conversación tomada por un humano → 409 ai_paused",
    sendPaused.res.status === 409 &&
      sendPaused.json?.error?.code === "ai_paused",
    JSON.stringify(sendPaused.json)
  );
  const outboxAfterPaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "y el rechazo ocurre ANTES de tocar Meta",
    outboxAfterPaused === outboxBeforePaused,
    `antes=${outboxBeforePaused} después=${outboxAfterPaused}`
  );

  const msgsBeforeReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  const rst = await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/reset → ok:true",
    rst.res.ok && rst.json?.ok === true,
    JSON.stringify(rst.json)
  );
  await sleep(400);
  convs = (await api("/api/conversations")).json?.conversations ?? [];
  const afterReset = convs.find((c) => c.id === convId);
  ok(
    "reset reactiva la IA (sale del handoff)",
    afterReset?.aiEnabled === true && !afterReset?.handoffAt,
    JSON.stringify({
      aiEnabled: afterReset?.aiEnabled,
      handoffAt: afterReset?.handoffAt,
    })
  );
  const msgsAfterReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  ok(
    "el reset conserva el historial (auditoría)",
    msgsAfterReset === msgsBeforeReset,
    `antes=${msgsBeforeReset} después=${msgsAfterReset}`
  );

  const stages = (await api("/api/pipeline/stages")).json?.stages ?? [];
  const firstStage = [...stages].sort((a, b) => a.position - b.position)[0];
  const detail = (await api(`/api/contacts/${afterReset?.contact.id}`)).json;
  ok(
    "reset regresa el lead a la primera etapa",
    !detail?.lead || detail?.stage?.id === firstStage?.id,
    `etapa=${detail?.stage?.name} esperada=${firstStage?.name}`
  );

  await quienRespondeChecks(convId);

  console.log("\n== FR-022: pedir un humano no deja al cliente en silencio ==");
  {
    /**
     * O padrão de contingência (antes do modelo) transferia SEM enviar nada: o
     * cliente que escrevia «quero falar com um humano» não recebia resposta,
     * embora por dentro a transferência acontecesse. Quem encontrou foi @fondeur27-09-73
     * (#62).
     *
     * O ai-mock, se recebesse essa frase, transferiria SEM `farewell` e com
     * motivo `modelo`. Assim, o motivo `cliente` prova que decidiu o
     * padrão, e a saída prova a correção: com o bug há zero mensagens.
     *
     * É preciso LIGAR o agente in-process de propósito, e desligá-lo no fim
     * para não alterar o que vem depois.
     */
    await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });

    // Contato novo por execução: com um fixo, a segunda execução o
    // encontraria já transferido e o agente não chegaria a rodar.
    const CORRIDA = Date.now().toString().slice(-6);
    const TEL = `5214628${CORRIDA}`;
    const CANONICO = `524628${CORRIDA}`;
    const decir = (texto, n) =>
      api("/api/dev/wa-mock/inbound", {
        method: "POST",
        body: JSON.stringify({
          phoneNumberId: PN,
          from: TEL,
          name: "Lead pide humano",
          text: texto,
          waMessageId: `wamid.e2e.022.${CORRIDA}.${n}`,
        }),
      });
    const convDe = async () =>
      ((await api("/api/conversations")).json?.conversations ?? []).find(
        (c) => c.contact.phone === CANONICO
      );
    const salientesDe = async (id) =>
      ((await api(`/api/conversations/${id}/messages`)).json?.messages ?? []).filter(
        (m) => m.direction === "out"
      );
    const alCliente = async () =>
      ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).filter(
        (o) => o.to === CANONICO
      );

    await decir("quiero hablar con un humano", 1);
    // O que se espera é a TRANSFERÊNCIA; quanto demore o debounce não é assunto
    // do check.
    await hasta(async () => Boolean((await convDe())?.handoffAt));
    const conv = await convDe();
    ok(
      "decide el patrón de respaldo, antes del modelo (motivo `cliente`)",
      Boolean(conv?.handoffAt) && conv?.handoffReason === "cliente",
      JSON.stringify({ handoffAt: conv?.handoffAt, reason: conv?.handoffReason })
    );

    if (conv) {
      const salientes = await salientesDe(conv.id);
      ok(
        "el cliente recibe un acuse antes del traspaso (antes: cero mensajes)",
        salientes.length === 1 && /persona del equipo/.test(salientes[0]?.text ?? ""),
        `salientes=${salientes.length} ${JSON.stringify(salientes.map((m) => m.text))}`
      );
      ok(
        "el acuse queda en la bandeja marcado como IA",
        salientes[0]?.aiGenerated === true && salientes[0]?.origin === "ai",
        JSON.stringify({ aiGenerated: salientes[0]?.aiGenerated, origin: salientes[0]?.origin })
      );
      const cable = await alCliente();
      ok(
        "y salió de verdad por el canal de WhatsApp, al número del cliente",
        cable.length === 1 && JSON.stringify(cable[0]?.body).includes("persona del equipo"),
        `envíos=${cable.length}`
      );

      // Um turno novo sobre a conversa JÁ transferida: sua última
      // mensagem recebida volta a ser a frase do padrão, então se o silêncio da
      // transferência não enviasse, o aviso sairia outra vez.
      await decir("sigo esperando, quiero hablar con un humano", 2);
      const coalesce = Number(process.env.AGENT_COALESCE_MS ?? 6000);
      await sleep(coalesce + 2500);
      ok(
        "tras el traspaso la IA calla: el acuse NO se repite",
        (await salientesDe(conv.id)).length === 1 && (await alCliente()).length === 1,
        `salientes=${(await salientesDe(conv.id)).length} envíos=${(await alCliente()).length}`
      );
    }

    await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
  }

  console.log("\n== 008: paridad inbox — echoes de coexistence (US1) ==");
  const LEAD = "5214627008001"; // canônica: 524627008001

  // Uma mensagem recebida primeiro: a conversa existe e a janela fica aberta.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      name: "Lead 008",
      text: "hola, quiero informes",
      waMessageId: "wamid.e2e.008.in.1",
    }),
  });
  await sleep(1200);
  const findConv008 = async () =>
    (((await api("/api/conversations")).json?.conversations) ?? []).find(
      (c) => c.contact.phone === "524627008001"
    );
  let conv008 = await findConv008();
  ok("conversación del lead 008 creada", Boolean(conv008), "sin conversación");
  const inboundAtBefore = conv008?.lastInboundAt;

  // Eco: o dono responde MANUALMENTE pelo aplicativo do telefone.
  const echo1 = await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: "wamid.e2e.008.echo.1",
    }),
  });
  ok("echo entregado al webhook", echo1.res.ok, JSON.stringify(echo1.json));
  await sleep(900);

  const msgs1 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const manual1 = msgs1.find((m) => m.text === "te contesto yo, dame un minuto");
  ok(
    "el mensaje manual aparece como saliente origin=manual",
    manual1?.direction === "out" && manual1?.origin === "manual" && manual1?.status === "sent",
    JSON.stringify(manual1)
  );

  // Espera-se a pausa, não um tempo fixo: o eco grava a mensagem e DEPOIS
  // pausa a IA. Ler a conversa entre um passo e outro —isso acontece com o
  // servidor recém-iniciado— dava a IA ligada sem que nada falhasse.
  await hasta(
    async () => {
      conv008 = await findConv008();
      return conv008?.handoffReason === "manual_reply";
    },
    5000,
    150
  );
  ok(
    "la IA quedó pausada con handoff manual_reply",
    conv008?.aiEnabled === false && conv008?.handoffReason === "manual_reply",
    JSON.stringify({ aiEnabled: conv008?.aiEnabled, reason: conv008?.handoffReason })
  );
  ok(
    "el echo NO tocó la ventana de 24 h (lastInboundAt intacto)",
    conv008?.lastInboundAt === inboundAtBefore,
    `${inboundAtBefore} → ${conv008?.lastInboundAt}`
  );

  // Idempotência: o mesmo eco de novo não duplica.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: "wamid.e2e.008.echo.1",
    }),
  });
  await sleep(700);
  const msgs2 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo duplicado (mismo wamid) no duplica el mensaje",
    msgs2.filter((m) => m.text === "te contesto yo, dame un minuto").length === 1
  );

  // Variante defensiva: ecos sob a chave `messages`.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "segundo mensaje manual",
      waMessageId: "wamid.e2e.008.echo.2",
      useMessagesKey: true,
    }),
  });
  await sleep(700);
  const msgs3 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo bajo la clave `messages` también se ingiere (parser tolerante)",
    msgs3.some((m) => m.text === "segundo mensaje manual" && m.origin === "manual")
  );

  // Eco para um número SEM conversa prévia → cria-a.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: "5214627008002",
      text: "hola, te escribo del anuncio",
      waMessageId: "wamid.e2e.008.echo.3",
    }),
  });
  await sleep(700);
  const convNew = (((await api("/api/conversations")).json?.conversations) ?? []).find(
    (c) => c.contact.phone === "524627008002"
  );
  ok("echo a número nuevo crea contacto y conversación", Boolean(convNew));

  // Reativação pelo CRM (fluxo existente de transferência).
  const react = await api(`/api/conversations/${conv008.id}`, {
    method: "PATCH",
    body: JSON.stringify({ reactivate: true }),
  });
  conv008 = await findConv008();
  ok(
    "reactivar la IA desde el CRM limpia el handoff",
    react.res.ok && conv008?.aiEnabled === true && !conv008?.handoffReason
  );

  console.log("\n== 008: enviar adjuntos desde el composer (US2) ==");
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
  const mediaForm = new FormData();
  mediaForm.set(
    "file",
    new Blob([JPEG_BYTES], { type: "image/jpeg" }),
    "local.jpg"
  );
  mediaForm.set("caption", "mira nuestro local");
  const upRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: mediaForm,
  });
  const upJson = await upRes.json().catch(() => null);
  ok("imagen con caption enviada (201)", upRes.status === 201, JSON.stringify(upJson));

  const msgs4 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentImg = msgs4.find((m) => m.media?.caption === "mira nuestro local");
  ok(
    "el saliente con imagen trae asset disponible y origin=operator",
    sentImg?.type === "image" &&
      sentImg?.origin === "operator" &&
      sentImg?.media?.fetchStatus === "available",
    JSON.stringify(sentImg)
  );

  const imgBin = await fetch(`${BASE}/api/media/${sentImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok(
    "GET /api/media/{id} sirve el binario con su content-type",
    imgBin.ok && (imgBin.headers.get("content-type") ?? "").includes("image/jpeg")
  );

  const outbox008 = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "el envío llegó a Graph como type=image con media id subido",
    outbox008.some((o) => o.type === "image" && JSON.stringify(o.body).includes("media-up-"))
  );

  // Caminho infeliz: arquivo que excede o limite (imagem > 5 MB) → 413 antes.
  const bigForm = new FormData();
  bigForm.set(
    "file",
    new Blob([Buffer.alloc(6 * 1024 * 1024)], { type: "image/png" }),
    "grande.png"
  );
  const bigRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: bigForm,
  });
  ok("imagen de 6 MB → 413 too_large ANTES de enviar", bigRes.status === 413);

  // Localização (payload estruturado, sem arquivo).
  const locRes = await api(`/api/conversations/${conv008.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      type: "location",
      location: { latitude: 21.019, longitude: -101.257, name: "Oficina Central" },
    }),
  });
  ok("ubicación enviada", locRes.res.ok, JSON.stringify(locRes.json));
  const msgs5 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentLoc = msgs5.find((m) => m.type === "location" && m.direction === "out");
  ok(
    "la ubicación viaja como payload (lat/long/name) sin binario",
    sentLoc?.media?.kind === "location" && sentLoc?.media?.payload?.latitude === 21.019,
    JSON.stringify(sentLoc?.media)
  );
  const outboxLoc = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "Graph recibió type=location",
    outboxLoc.some((o) => o.type === "location")
  );

  console.log("\n== 008: previews de adjuntos entrantes (US3) ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "media-e2e-img-1",
      caption: "foto de mi negocio",
      waMessageId: "wamid.e2e.008.in.img",
    }),
  });
  await sleep(1600); // ingestão + download in-process do binário
  const msgs6 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inImg = msgs6.find((m) => m.media?.caption === "foto de mi negocio");
  ok(
    "imagen entrante queda disponible tras la descarga in-process",
    inImg?.direction === "in" &&
      inImg?.media?.kind === "image" &&
      inImg?.media?.fetchStatus === "available",
    JSON.stringify(inImg?.media)
  );
  const inImgBin = await fetch(`${BASE}/api/media/${inImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok("el binario entrante se sirve desde el volumen local", inImgBin.ok);

  // Localização recebida: payload direto, sem binário (404 em /api/media).
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "location",
      location: { latitude: 20.5, longitude: -100.8, name: "Mi taller" },
      waMessageId: "wamid.e2e.008.in.loc",
    }),
  });
  await sleep(900);
  const msgs7 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inLoc = msgs7.find((m) => m.type === "location" && m.direction === "in");
  ok(
    "ubicación entrante trae payload directo",
    inLoc?.media?.payload?.name === "Mi taller",
    JSON.stringify(inLoc?.media)
  );

  // Caminho infeliz: mídia cujo download falha (metadado sem url) → failed,
  // a mensagem é preservada e /api/media responde 410.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "broken-no-url",
      waMessageId: "wamid.e2e.008.in.broken",
    }),
  });
  await sleep(1600);
  const msgs8 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const broken = msgs8.find((m) => m.id !== inImg?.id && m.media?.fetchStatus === "failed");
  ok(
    "descarga fallida degrada a failed sin perder el mensaje",
    Boolean(broken),
    JSON.stringify(msgs8.filter((m) => m.media).map((m) => m.media))
  );
  if (broken) {
    const goneRes = await fetch(`${BASE}/api/media/${broken.media.assetId}`, {
      headers: { cookie, origin: BASE },
    });
    ok("asset fallido → 410 gone en /api/media", goneRes.status === 410);
  }

  // Eco COM anexo (AC-5 do US1): a foto que o dono mandou do celular.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      type: "image",
      mediaId: "media-e2e-echo-img",
      caption: "así quedaría tu logo",
      waMessageId: "wamid.e2e.008.echo.img",
    }),
  });
  await sleep(1600);
  const msgs9 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const echoImg = msgs9.find((m) => m.media?.caption === "así quedaría tu logo");
  ok(
    "echo con imagen: manual + asset descargado y previsualizable",
    echoImg?.origin === "manual" && echoImg?.media?.fetchStatus === "available",
    JSON.stringify(echoImg?.media)
  );

  await respuestasDeBotonChecks();
  await agendaChecks();
  await atribucionChecks();
  await anuncioDeOrigenChecks();
  await r11BotChecks();

  console.log(`\n===== ${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

/* ============================================================
 * #78 — Respostas de botão. Quando o cliente toca num botão de resposta
 * rápida de um modelo, a Meta envia `type: "button"`; quando toca um botão
 * ou uma linha de lista de uma mensagem interativa, `type: "interactive"`. A
 * ingestão os descartava: nem bandeja, nem janela de 24 h, nem agente. Agora
 * entram como texto com o rótulo do botão, igual se o tivesse digitado. Os
 * payloads do mock têm o formato documentado pela Meta.
 * ========================================================================== */
async function respuestasDeBotonChecks() {
  console.log("\n== #78: una respuesta de botón entra como texto del cliente ==");
  // Contato novo por execução: a seção conta as recebidas e espera a
  // resposta do agente a ESTE botão, não às de uma execução anterior.
  const CORRIDA = Date.now().toString().slice(-6);
  const LEAD_B = `5215550${CORRIDA}`;
  const TEL_B = `525550${CORRIDA}`;

  const perfilAntes = (await api("/api/agent/profile")).json?.profile?.enabled;
  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });

  const entrante = (extra, n) =>
    api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: LEAD_B,
        name: "Lead botones",
        waMessageId: `wamid.e2e.78.${CORRIDA}.${n}`,
        ...extra,
      }),
    });
  const conversacion = async () =>
    ((await api("/api/conversations")).json?.conversations ?? []).find(
      (c) => c.contact.phone === TEL_B
    ) ?? null;
  const mensajesDe = async (convId) =>
    (await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
  const entrantes = async (convId) =>
    (await mensajesDe(convId)).filter((m) => m.direction === "in");

  // 1) Botão de resposta rápida de um modelo.
  const envio = await entrante(
    { type: "button", button: { text: "Sí, me interesa", payload: "SI_INTERESA" } },
    1
  );
  ok("el webhook acepta un `type: \"button\"`", envio.res.ok, JSON.stringify(envio.json));
  let conv = null;
  await hasta(async () => {
    conv = await conversacion();
    return !!conv;
  });
  ok("el botón de plantilla crea la conversación en la bandeja", !!conv);
  if (conv) {
    const boton = (await entrantes(conv.id)).find((m) => m.text === "Sí, me interesa");
    ok(
      "y queda como texto con el rótulo del botón (type=text, no button)",
      boton?.type === "text",
      JSON.stringify((await mensajesDe(conv.id)).map((m) => [m.direction, m.type, m.text]))
    );
    // A conversa foi relida: a de cima foi pega assim que apareceu, e a
    // ingestão a cria ANTES de salvar a mensagem e anotar a hora. Lida nesse
    // intervalo, a janela saía fechada sem que o produto falhasse.
    conv = (await conversacion()) ?? conv;
    ok(
      "abre la ventana de 24 h",
      conv.windowOpen === true && !!conv.lastInboundAt,
      JSON.stringify({ windowOpen: conv.windowOpen, lastInboundAt: conv.lastInboundAt })
    );
    const contesto = await hasta(
      async () =>
        (await mensajesDe(conv.id)).some(
          (m) =>
            m.direction === "out" &&
            m.aiGenerated === true &&
            (m.text ?? "").includes("Sí, me interesa")
        ),
      20000
    );
    ok(
      "y dispara al agente como cualquier texto (contestó por el ai-mock)",
      contesto,
      JSON.stringify((await mensajesDe(conv.id)).map((m) => [m.direction, m.text]))
    );

    // 2) Botão de uma mensagem interativa.
    await entrante(
      {
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "cancel-button", title: "Cancelar" },
        },
      },
      2
    );
    const hayCancelar = await hasta(async () =>
      (await entrantes(conv.id)).some((m) => m.type === "text" && m.text === "Cancelar")
    );
    ok("un button_reply interactivo entra como texto con su título", hayCancelar);

    // 3) Linha de uma lista.
    await entrante(
      {
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: {
            id: "priority_express",
            title: "Envío exprés",
            description: "Llega mañana",
          },
        },
      },
      3
    );
    const hayLista = await hasta(async () =>
      (await entrantes(conv.id)).some((m) => m.type === "text" && m.text === "Envío exprés")
    );
    ok("un list_reply entra como texto con el título de la fila (no la descripción)", hayLista);

    // Caminho infeliz: resposta sem rótulo nem id → descarta-se com aviso e
    // o webhook segue vivo; o fio não ganha uma mensagem vazia.
    const roto = await entrante(
      { type: "interactive", interactive: { type: "button_reply", button_reply: {} } },
      4
    );
    ok("una respuesta de botón sin rótulo no tumba el webhook", roto.res.ok);
    await sleep(800);
    const n = (await entrantes(conv.id)).length;
    ok("y no deja un mensaje vacío en el hilo", n === 3, `entrantes=${n}`);
  }

  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: perfilAntes === true }),
  });
}

/* ============================================================
 * «Quién responde a tus clientes» (tests/e2e/us-bot-api.md, passos 40-44)
 *
 * O agente incluído e um cérebro externo (Nea) não se veem entre si: com os
 * dois ativos, o cliente recebe duas respostas. O cartão do Agente diz isso
 * com dois sinais: a última chamada autenticada a /api/bot/* (em
 * memória) e o /health da Nea se houver BRAIN_HEALTH_URL. Aqui se sobe uma
 * Nea FALSA na porta dessa URL (tem que ser local) — o app já roda
 * com ela no seu .env — e ela é deixada saudável e depois travada.
 * ============================================================ */

/** Uma Nea de mentira: responde seu /health como a Nea de verdade. */
async function levantarNeaFalsa(url) {
  const { createServer } = await import("node:http");
  const estado = { modo: "sana", pedidos: 0, ultimaAuth: null, ultimaRuta: null };
  const server = createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] !== url.pathname) {
      res.writeHead(404);
      return res.end();
    }
    estado.pedidos++;
    estado.ultimaAuth = req.headers.authorization ?? null;
    estado.ultimaRuta = req.url;
    if (estado.modo === "colgada") return; // nunca responde
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        db: "ok",
        version: "1.0.0",
        commit: "abc1234",
        commitVerified: true,
        mode: "estándar",
        relay: { pendientes: 0, masViejoSegundos: null, ultimoErrorEn: null },
      })
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ""), resolve);
  });
  return {
    estado,
    cerrar: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function quienRespondeChecks(convId) {
  console.log("\n== quién responde: la tarjeta del Agente ==");
  const estado = async () => (await api("/api/agent/brain-status")).json;

  const raw = process.env.BRAIN_HEALTH_URL;
  const url = raw ? new URL(raw) : null;
  const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url && !local) {
    console.log(`  SKIP /health: BRAIN_HEALTH_URL apunta a ${url.host}, no a esta máquina`);
  }
  // Antes da primeira consulta: assim o cache de 15 s não guarda um «não está
  // online» de antes de a Nea falsa existir.
  const nea = local ? await levantarNeaFalsa(url) : null;
  const perfil = (await api("/api/agent/profile")).json;
  const enabledOriginal = perfil?.profile?.enabled === true;
  try {
    await quienResponde(convId, estado, url, nea);
  } finally {
    await nea?.cerrar();
    await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ enabled: enabledOriginal }),
    });
  }
}

async function quienResponde(convId, estado, url, nea) {
  const anon = await fetch(`${BASE}/api/agent/brain-status`);
  ok("brain-status sin sesión → 401", anon.status === 401);

  const antes = await estado();
  ok(
    "brain-status con sesión → las dos filas y el aviso",
    typeof antes?.embedded?.answering === "boolean" &&
      typeof antes?.external?.active === "boolean" &&
      "warning" in (antes ?? {}),
    JSON.stringify(antes)
  );
  ok("la llave del cerebro externo cuenta como configurada", antes?.external?.keyConfigured === true);

  // A última chamada: só a move uma chamada AUTENTICADA.
  await sleep(1100);
  await api("/api/bot/profile", { headers: { "x-api-key": "x".repeat(BOT_KEY.length) } });
  const trasMala = await estado();
  ok(
    "una llamada con key equivocada NO cuenta como «visto»",
    trasMala?.external?.lastSeenAt === antes?.external?.lastSeenAt,
    `${antes?.external?.lastSeenAt} → ${trasMala?.external?.lastSeenAt}`
  );
  const ctx = await bot(`/api/bot/context?conversationId=${convId}`);
  ok("GET /api/bot/context con la key → 200", ctx.res.ok);
  const despues = await estado();
  const tAntes = Date.parse(antes?.external?.lastSeenAt ?? "") || 0;
  const tDespues = Date.parse(despues?.external?.lastSeenAt ?? "") || 0;
  ok(
    "…y lastSeenAt avanza",
    tDespues > tAntes && Date.now() - tDespues < 30_000,
    `${antes?.external?.lastSeenAt} → ${despues?.external?.lastSeenAt}`
  );
  ok("…y el cerebro externo cuenta como activo", despues?.external?.active === true);

  if (!url) {
    ok("sin BRAIN_HEALTH_URL no se le pregunta a nadie (health: null)", despues?.external?.health === null);
    console.log(
      "  (para probar el /health: BRAIN_HEALTH_URL=http://127.0.0.1:<puerto>/health en .env y reinicia la app)"
    );
  }

  if (nea) {
    // Uma execução anterior pode ter deixado em cache a sua Nea travada (15 s).
    let h = null;
    const enLinea = await hasta(async () => {
      h = (await estado())?.external?.health ?? null;
      return h?.reachable === true;
    }, 25_000, 1000);
    ok("con la Nea falsa sana: en línea", enLinea, JSON.stringify(h));
    ok(
      "…con versión, modo y cola del relevo",
      h?.version === "1.0.0" && h?.mode === "estándar" && h?.relay?.pendientes === 0,
      JSON.stringify(h)
    );
    ok("…y solo el host de la URL", h?.host === url.host, h?.host);
    const dump = JSON.stringify(await estado());
    const secretos = [url.username, url.password, url.search.slice(1)].filter(Boolean);
    ok(
      "credenciales y query de BRAIN_HEALTH_URL no salen en la respuesta",
      secretos.every((s) => !dump.includes(decodeURIComponent(s))),
      `revisados ${secretos.length}`
    );
    if (url.username || url.password) {
      ok(
        "…pero sí viajan a Nea (Authorization: Basic)",
        nea.estado.ultimaAuth ===
          `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
      );
    }
    const pedidosAntes = nea.estado.pedidos;
    await Promise.all([estado(), estado(), estado()]);
    ok(
      "tres consultas seguidas no martillan a Nea (caché)",
      nea.estado.pedidos === pedidosAntes,
      `${pedidosAntes} → ${nea.estado.pedidos}`
    );
  }

  // Os dois respondendo: o aviso vermelho.
  const on = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  ok("agente incluido encendido desde la pantalla", on.res.ok);
  const doble = await estado();
  ok(
    "con token de IA + agente encendido + cerebro externo activo → doble_respuesta",
    doble?.embedded?.configured === true &&
      doble?.embedded?.answering === true &&
      doble?.warning === "doble_respuesta",
    JSON.stringify({ embedded: doble?.embedded, warning: doble?.warning })
  );
  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });
  const solo = await estado();
  ok(
    "apagar el agente incluido quita el aviso (contesta solo el externo)",
    solo?.embedded?.answering === false && solo?.warning === null,
    JSON.stringify({ embedded: solo?.embedded, warning: solo?.warning })
  );

  if (nea) {
    // Nea travada: o cartão percebe sem ficar esperando.
    nea.estado.modo = "colgada";
    let h = null;
    let masLenta = 0;
    const caida = await hasta(async () => {
      const t0 = Date.now();
      h = (await estado())?.external?.health ?? null;
      masLenta = Math.max(masLenta, Date.now() - t0);
      return h?.reachable === false;
    }, 25_000, 1000);
    ok(
      "con Nea colgada: no está en línea, por tiempo agotado",
      caida && h?.problem === "timeout",
      JSON.stringify(h)
    );
    ok(
      "…y la consulta no se cuelga con ella (≤ 4 s)",
      masLenta <= 4000,
      `${masLenta} ms`
    );
    const sigue = await estado();
    ok(
      "…la llamada reciente la sigue contando como activa",
      sigue?.external?.active === true,
      JSON.stringify(sigue?.external)
    );
  }
}

/* ============================================================
 * Guia de início — a primeira tela (tests/e2e/us-guia-de-inicio.md, #86)
 *
 * O que se protege: que a raiz mande para o guia enquanto falte um passo ou o
 * agente continue desligado, que cada passo se marque sozinho quando a peça de verdade
 * funciona (a mesma fonte que usa o resto do app), e que «Encender»
 * tire o guia do caminho. Roda logo após o login, antes que o
 * resto do roteiro conecte qualquer coisa: assim se vê a instância como a vê quem
 * acabou de instalar. Numa NOVA EXECUÇÃO o banco já traz de tudo, então
 * primeiro volta-se ao ponto de partida (sem chave, sem número, agente sem
 * instruções e desligado) e no final deixa-se como estava para o que vem depois.
 * ============================================================ */

async function guiaChecks() {
  console.log("\n== guía de inicio: la primera pantalla ==");
  const agenda = /^(on|1|true|si|sí|yes)$/i.test((process.env.AGENDA ?? "").trim());
  // O app lê o mesmo .env deste roteiro: se trouxer a chave, o passo 2 já
  // está pronto «por el respaldo del entorno», e o guia diz isso.
  const respaldoEnv = Boolean((process.env.OPENROUTER_API_TOKEN ?? "").trim());

  const estado = async () => (await api("/api/onboarding/status")).json;
  const paso = async (key) => (await estado())?.steps?.find((s) => s.key === key);
  /** Para onde a raiz manda com a sessão do operador. */
  const raiz = async () => {
    const res = await fetch(`${BASE}/`, { redirect: "manual", headers: { cookie } });
    const loc = res.headers.get("location") ?? "";
    return `${res.status} ${loc}`;
  };
  const mandaA = (destino) => (r) =>
    /^30[0-9] /.test(r) && (r.endsWith(destino) || r.endsWith(`${destino}/`));
  // O React separa as expressões JSX com `<!-- -->` no HTML do servidor:
  // «Deja listo tu CRM en <!-- -->4<!-- --> pasos». Compara-se o texto.
  const texto = (h) => h.replace(/<!--.*?-->/g, "");

  // --- Ponto de partida reproduzível ---
  await api("/api/settings/ai", { method: "DELETE" });
  await api("/api/settings/whatsapp", { method: "DELETE" });
  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: false, instructions: null }),
  });
  for (const e of (await api("/api/kb")).json?.entries ?? []) {
    await api(`/api/kb/${e.id}`, { method: "DELETE" });
  }
  if (agenda) {
    // Todos os dias fechados: o passo 4 fica pendente mesmo que uma execução
    // anterior já tivesse salvo horários.
    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "enlace-fijo", weeklyHours: {} }),
    });
  }

  // --- O que vê quem acabou de instalar ---
  const anon = await fetch(`${BASE}/api/onboarding/status`);
  ok("estado sin sesión → 401", anon.status === 401, `status=${anon.status}`);

  const inicial = await estado();
  ok(
    "GET /api/onboarding/status → pasos verificados + guía + agente apagado",
    Array.isArray(inicial?.steps) && inicial?.enabled === false && inicial?.guide?.complete === false,
    JSON.stringify(inicial)
  );
  ok(
    "los pasos de la raíz: agente, IA, WhatsApp y agenda",
    JSON.stringify(inicial?.steps?.map((s) => s.key)) ===
      JSON.stringify(["profile", "ai", "whatsapp", "calendar"]),
    JSON.stringify(inicial?.steps?.map((s) => s.key))
  );
  const guiaKeys = inicial?.guide?.steps?.map((s) => s.key) ?? [];
  ok(
    agenda
      ? "con la agenda encendida la guía tiene 4 pasos"
      : "sin agenda la guía tiene 3 pasos (el de agenda ni se pinta)",
    JSON.stringify(guiaKeys) ===
      JSON.stringify(agenda ? ["agent", "ai", "whatsapp", "calendar"] : ["agent", "ai", "whatsapp"]),
    JSON.stringify(guiaKeys)
  );
  const perfil0 = inicial?.steps?.find((s) => s.key === "profile");
  ok(
    "el agente con nombre de fábrica y sin instrucciones está pendiente y dice qué falta",
    perfil0?.status === "pending" && /nombre/.test(perfil0?.nextAction ?? ""),
    JSON.stringify(perfil0)
  );
  ok(
    "WhatsApp sin número → pendiente",
    inicial?.steps?.find((s) => s.key === "whatsapp")?.status === "pending"
  );
  const ia0 = inicial?.steps?.find((s) => s.key === "ai");
  ok(
    respaldoEnv
      ? "IA: sin fila guardada cuenta el respaldo del entorno (OPENROUTER_*)"
      : "IA: sin fila ni entorno → pendiente",
    respaldoEnv
      ? ia0?.status === "ready" && /entorno/.test(ia0?.nextAction ?? "")
      : ia0?.status === "pending",
    JSON.stringify(ia0)
  );

  const r0 = await raiz();
  ok("la raíz manda a /onboarding mientras falte un paso", mandaA("/onboarding")(r0), r0);

  // A tela é compilada na sua primeira requisição no `next dev`: espera ativa.
  let html = "";
  const pantalla = await hasta(async () => {
    const res = await fetch(`${BASE}/onboarding`, { headers: { cookie } });
    html = res.ok ? texto(await res.text()) : "";
    return res.ok && html.includes("Deja listo tu CRM en");
  }, 40_000, 1000);
  ok("la pantalla /onboarding carga con la cabecera «Deja listo tu CRM en N pasos»", pantalla);
  ok(
    `…y cuenta los ${guiaKeys.length} pasos de esta instancia`,
    html.includes(`Deja listo tu CRM en ${guiaKeys.length} pasos`)
  );
  ok(
    "…con la tarjeta final explicando que el agente empieza apagado",
    html.includes("Al final: encender a") && html.includes("empieza apagado")
  );
  ok("…y la entrada «Guía de inicio» en el menú", html.includes("Guía de inicio"));

  // --- Os passos se marcam sozinhos ---
  const perfilOk = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ name: "Sofi", instructions: "Vendemos limpiezas dentales." }),
  });
  ok(
    "paso 1: guardar nombre + instrucciones lo deja listo",
    perfilOk.res.ok && (await paso("profile"))?.status === "ready"
  );

  const guardarIa = await api("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({
      provider: "openai_compatible",
      baseUrl: process.env.OPENROUTER_BASE_URL ?? `${BASE}/api/dev/ai-mock`,
      model: "mock/modelo-e2e",
      token: "tok-ia-e2e-0001",
    }),
  });
  const iaFila = await paso("ai");
  ok(
    "paso 2: la llave guardada en Ajustes → IA lo deja listo (la fila manda)",
    guardarIa.res.ok && iaFila?.status === "ready" && /Ajustes/.test(iaFila?.nextAction ?? ""),
    `status=${guardarIa.res.status} ${JSON.stringify(iaFila)}`
  );

  const conectar = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ wabaId: "WABA-E2E", phoneNumberId: PN, token: "tok-e2e" }),
  });
  ok(
    "paso 3: conectar el número lo deja listo",
    conectar.res.ok && (await paso("whatsapp"))?.status === "ready",
    `status=${conectar.res.status}`
  );

  if (agenda) {
    const cerrado = await paso("calendar");
    ok(
      "paso 4: con todos los días cerrados la agenda sigue pendiente",
      cerrado?.status === "pending" && cerrado?.href === "/settings/calendar",
      JSON.stringify(cerrado)
    );
    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({
        connector: "zoom",
        weeklyHours: { mon: [{ start: "09:00", end: "18:00" }] },
      }),
    });
    const zoomSinCred = await paso("calendar");
    ok(
      "paso 4: Zoom elegido sin credencial → pendiente, y la pista lo dice",
      zoomSinCred?.status === "pending" && /Zoom/.test(zoomSinCred?.problem ?? ""),
      JSON.stringify(zoomSinCred)
    );
    const horario = await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({
        connector: "enlace-fijo",
        weeklyHours: {
          mon: [{ start: "09:00", end: "18:00" }],
          tue: [{ start: "09:00", end: "18:00" }],
          wed: [{ start: "09:00", end: "18:00" }],
          thu: [{ start: "09:00", end: "18:00" }],
          fri: [{ start: "09:00", end: "18:00" }],
        },
      }),
    });
    ok(
      "paso 4: horarios + enlace fijo lo deja listo sin credenciales de nadie",
      horario.res.ok && (await paso("calendar"))?.status === "ready"
    );
  } else {
    const noAplica = await paso("calendar");
    ok(
      "sin agenda el paso se reporta «no aplica» y sin enlace",
      noAplica?.status === "not_applicable" && noAplica?.href === null,
      JSON.stringify(noAplica)
    );
  }

  // --- Encender ---
  const listo = await estado();
  ok(
    "con todo listo: guía completa y agente todavía apagado",
    listo?.guide?.complete === true && listo?.enabled === false,
    JSON.stringify(listo?.guide)
  );
  const r1 = await raiz();
  ok("…y la raíz SIGUE mandando a /onboarding: falta encenderlo", mandaA("/onboarding")(r1), r1);
  const htmlListo = texto(await (await fetch(`${BASE}/onboarding`, { headers: { cookie } })).text());
  ok(
    "la tarjeta final ofrece «Encender a Sofi» (el nombre, ya configurado)",
    htmlListo.includes("Enciende a Sofi") && htmlListo.includes("Encender a Sofi")
  );

  const encender = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  ok("Encender → PUT /api/agent/profile {enabled:true}", encender.res.ok);
  const encendido = await estado();
  ok("…y la guía lo refleja", encendido?.enabled === true && encendido?.guide?.enabled === true);
  const r2 = await raiz();
  ok("con todo listo y encendido la raíz manda a la Bandeja", mandaA("/inbox")(r2), r2);
  const htmlEncendido = texto(await (await fetch(`${BASE}/onboarding`, { headers: { cookie } })).text());
  ok(
    "la guía sigue disponible y dice que Sofi ya está contestando",
    htmlEncendido.includes("Sofi ya está contestando") && htmlEncendido.includes("Ir a la Bandeja")
  );

  // --- Como estava, para o que vem depois ---
  await api("/api/agent/profile", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  // Sem a linha, o resto do roteiro segue falando com o ai-mock pelo
  // respaldo do ambiente, como antes desta seção.
  await api("/api/settings/ai", { method: "DELETE" });
}

/* ============================================================
 * us5 — Salvar a conexão registra o webhook na Meta e respeita o
 * override de um cérebro externo (tests/e2e/us5-connect.md, passos 3, 4, 4b,
 * 7 e 8)
 *
 * Antes, salvar deixava o operador pela metade: o token era válido e dava para
 * enviar, mas nada chegava até alguém colar a URL no painel do seu
 * app da Meta. Agora o CRM a registra ele mesmo, como override do
 * NÚMERO, e a «Meta» (o wa-mock) faz o handshake de verdade contra a rota.
 *
 * E o de sempre: na Meta, `POST {WABA}/subscribed_apps` SEM corpo é a
 * forma documentada de APAGAR o override de callback da WABA, e o CRM o
 * mandava a cada "Guardar": um cérebro externo (Nea) que recebe os webhooks
 * por esse override ficava surdo sem que nada o avisasse. O override do
 * número ganharia igual, então com um alheio na WABA o CRM não o põe.
 * O wa-mock se comporta como a Meta, então se o CRM voltar a sobrescrever às
 * cegas, isto fica vermelho.
 * ============================================================ */

async function overrideChecks() {
  console.log("\n== us5: guardar registra el webhook y no desconecta a un cerebro externo ==");
  const WABA = "WABA-E2E";
  const NEA = "https://nea.e2e.test/api/webhooks/meta";
  const graph = `/api/dev/wa-mock/graph/v25.0/${WABA}/subscribed_apps`;
  const comoMeta = { authorization: "Bearer tok-e2e" };

  const suscripcion = async () =>
    (await api(graph, { headers: comoMeta })).json?.data ?? [];
  const overrideActual = async () =>
    (await suscripcion()).find((app) => app.override_callback_uri)
      ?.override_callback_uri ?? null;
  /** O override que a «Meta» tem no NÚMERO (o que o CRM registra). */
  const webhookDelNumero = async () =>
    (await api("/api/dev/wa-mock/webhooks")).json?.phoneWebhooks?.[PN] ?? null;
  const guardar = (token) =>
    api("/api/settings/whatsapp", {
      method: "PUT",
      body: JSON.stringify({ wabaId: WABA, phoneNumberId: PN, token }),
    });
  const urlPropia = (await api("/api/settings/webhook")).json?.url ?? null;

  // Modo direto: sem override, salvar inscreve o app, como sempre…
  let guardado = await guardar("tok-e2e");
  const trasGuardar = await suscripcion();
  ok(
    "sin override, guardar la conexión suscribe la app a la WABA",
    guardado.res.ok &&
      trasGuardar.length === 1 &&
      !trasGuardar[0]?.override_callback_uri,
    JSON.stringify({ status: guardado.res.status, trasGuardar })
  );
  // …e registra o webhook da instância no número (passou pelo handshake).
  ok(
    "y registra el webhook de la instancia en el NÚMERO (handshake incluido)",
    guardado.json?.webhook?.ok === true &&
      guardado.json.webhook.appWithoutWebhook === false &&
      !!urlPropia &&
      (await webhookDelNumero()) === urlPropia,
    JSON.stringify({ webhook: guardado.json?.webhook, urlPropia, enMeta: await webhookDelNumero() })
  );

  // O botão «Registrar en Meta» repete isso com a conexão salva.
  const boton = await api("/api/settings/webhook", { method: "POST" });
  ok(
    "«Registrar en Meta» repite el registro sin volver a pegar el token",
    boton.res.ok && boton.json?.ok === true && (await webhookDelNumero()) === urlPropia,
    JSON.stringify(boton.json)
  );

  // Um token sem whatsapp_business_management: a Meta recusa o registro, a
  // conexão é salva mesmo assim e o motivo vai na resposta.
  const sinGestion = await guardar("tok-e2e-sin-gestion");
  ok(
    "sin permiso de gestión, la conexión se guarda (200) y avisa por qué no registró",
    sinGestion.res.ok &&
      sinGestion.json?.webhook?.ok === false &&
      sinGestion.json.webhook.code === "missing_permission",
    JSON.stringify({ status: sinGestion.res.status, webhook: sinGestion.json?.webhook })
  );
  const botonSinGestion = await api("/api/settings/webhook", { method: "POST" });
  ok(
    "y el botón devuelve el mismo motivo con 422",
    botonSinGestion.res.status === 422 &&
      botonSinGestion.json?.error?.code === "missing_permission",
    JSON.stringify(botonSinGestion.json)
  );
  await guardar("tok-e2e");

  // O cérebro externo define SEU override contra a Meta (o que faz a Nea).
  const fijado = await api(graph, {
    method: "POST",
    headers: comoMeta,
    body: JSON.stringify({
      override_callback_uri: NEA,
      verify_token: "verify-e2e",
    }),
  });
  ok(
    "el cerebro externo fija su override en la WABA",
    fijado.res.ok && (await overrideActual()) === NEA
  );

  // Girar o token e salvar outra vez — o caso que a desconectava.
  guardado = await guardar("tok-e2e-rotado");
  ok(
    "guardar la conexión con el token rotado responde 200",
    guardado.res.ok,
    JSON.stringify(guardado.json)
  );
  const despues = await overrideActual();
  ok(
    "y el override del cerebro externo SIGUE en la WABA",
    despues === NEA,
    `override=${despues}`
  );
  // O override do número vence o da WABA: com um alheio, o CRM não põe
  // o seu e remove o que o salvamento anterior tinha deixado.
  ok(
    "y el número queda SIN override propio: el cerebro externo sigue recibiendo",
    guardado.json?.webhook?.skipped === "waba_override" &&
      guardado.json.webhook.host === "nea.e2e.test" &&
      (await webhookDelNumero()) === null,
    JSON.stringify({ webhook: guardado.json?.webhook, enMeta: await webhookDelNumero() })
  );

  // Controle do próprio mock: um POST sem corpo APAGA o override, como na
  // Meta. Sem isso, a verificação anterior poderia passar contra um mock permissivo.
  await api(graph, { method: "POST", headers: comoMeta });
  ok(
    "control: un POST sin cuerpo borra el override (así se comporta Meta)",
    (await overrideActual()) === null
  );

  // Desconectar: remove o override do número na Meta ANTES de soltar o
  // token, e a bandeja não é tocada. Depois o roteiro segue com a conexão de
  // sempre.
  await guardar("tok-e2e");
  const antesDeSoltar = await webhookDelNumero();
  const soltar = await api("/api/settings/whatsapp", { method: "DELETE" });
  const sinConexion = (await api("/api/settings/whatsapp")).json?.connection;
  ok(
    "desconectar borra la conexión y quita el override del número en Meta",
    soltar.res.ok &&
      antesDeSoltar === urlPropia &&
      sinConexion === null &&
      (await webhookDelNumero()) === null,
    JSON.stringify({ status: soltar.res.status, antesDeSoltar, sinConexion, enMeta: await webhookDelNumero() })
  );
  const reconectado = await guardar("tok-e2e");
  ok(
    "y volver a guardar lo deja registrado otra vez",
    reconectado.res.ok && (await webhookDelNumero()) === urlPropia,
    JSON.stringify(reconectado.json)
  );
}

/* ============================================================
 * 015 — Motor de agenda universal (tests/e2e/us-agenda.md)
 *
 * Cobre as duas configurações da flag, as duas garantias
 * inegociáveis com seus CÓDIGOS EXATOS, a corrida do horário, o link
 * pendente quando o provedor falha, e o sandbox do Laboratório.
 * ============================================================ */

async function agendaChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.AGENDA ?? "").trim()
  );

  console.log("\n== 015: la bandera de la agenda ==");
  const rutas = [
    "/api/calendar/settings",
    "/api/calendar/availability",
    "/api/bookings",
  ];

  if (!encendida) {
    // Com a flag desligada a agenda NÃO EXISTE: nem rotas de operador, nem de
    // serviço, nem telas. É a metade do contrato que quase nunca se
    // testa, e a que toda instância normal usa.
    for (const ruta of rutas) {
      const { res } = await api(ruta);
      ok(`${ruta} → 404 con la agenda apagada`, res.status === 404, `status=${res.status}`);
    }
    const botAvail = await bot("/api/bot/availability?conversationId=x");
    ok(
      "/api/bot/availability → 404 con la agenda apagada",
      botAvail.res.status === 404,
      `status=${botAvail.res.status}`
    );
    const page = await fetch(`${BASE}/bookings`, { headers: { cookie } });
    ok("la pantalla /bookings no existe", page.status === 404, `status=${page.status}`);
    console.log("  (agenda apagada: el resto de los checks de 015 no aplican)");
    return;
  }

  for (const ruta of rutas) {
    const { res } = await api(ruta);
    ok(`${ruta} responde con la agenda encendida`, res.ok, `status=${res.status}`);
  }

  console.log("\n== 015: configuración de la agenda (US2) ==");
  const defaults = (await api("/api/calendar/settings")).json?.settings;
  ok(
    "una instancia sin configurar da defaults usables, no 404",
    defaults?.slotMinutes === 30 && defaults?.connector === "enlace-fijo",
    JSON.stringify(defaults)
  );

  const SALA = "https://meet.ejemplo.test/sala-fija";
  const guardado = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({
      weeklyHours: {
        mon: [{ start: "09:00", end: "18:00" }],
        tue: [{ start: "09:00", end: "18:00" }],
        wed: [{ start: "09:00", end: "18:00" }],
        thu: [{ start: "09:00", end: "18:00" }],
        fri: [{ start: "09:00", end: "18:00" }],
        sat: [{ start: "09:00", end: "18:00" }],
        sun: [{ start: "09:00", end: "18:00" }],
      },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 7,
      connector: "enlace-fijo",
      meetingLink: SALA,
    }),
  });
  ok("se guarda el horario y la sala fija", guardado.res.ok, `status=${guardado.res.status}`);

  const tzMala = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ timezone: "Marte/Olympus" }),
  });
  ok(
    "una zona horaria inventada se rechaza (422) en vez de romper el motor",
    tzMala.res.status === 422,
    `status=${tzMala.res.status}`
  );

  const disp = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok("hay huecos ofrecibles tras configurar", disp.length > 0, `slots=${disp.length}`);
  ok(
    "cada hueco trae el día EN PALABRAS, no solo la hora",
    Boolean(disp[0]?.dayLabel && disp[0]?.time),
    JSON.stringify(disp[0])
  );

  console.log("\n== 015: las dos garantías (US3) ==");
  const LEAD_A = "5214627015001";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_A,
      name: "Lead agenda A",
      text: "quiero agendar",
      waMessageId: "wamid.e2e.015.a.1",
    }),
  });
  const LEAD_B = "5214627015002";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_B,
      name: "Lead agenda B",
      text: "yo también quiero",
      waMessageId: "wamid.e2e.015.b.1",
    }),
  });
  await sleep(1500);

  const convsAgenda = (await api("/api/conversations")).json?.conversations ?? [];
  const convA = convsAgenda.find((c) => c.contact.phone === "524627015001");
  const convB = convsAgenda.find((c) => c.contact.phone === "524627015002");
  ok("dos conversaciones de prueba listas", Boolean(convA && convB));
  if (!convA || !convB) return;

  const ofertaA = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotsA = ofertaA.json?.slots ?? [];
  ok("ofrecer horarios devuelve huecos", slotsA.length > 0, `slots=${slotsA.length}`);
  ok(
    "el reparto cubre más de un día (no todo hoy)",
    (ofertaA.json?.diasConAgenda ?? []).length > 1,
    JSON.stringify(ofertaA.json?.diasConAgenda)
  );

  // GARANTIA 1: um instante livre mas NUNCA ofertado é recusado.
  const noOfrecido = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({
      conversationId: convA.id,
      // Um minuto depois de um vão real: válido, livre e nunca ofertado.
      startUtc: new Date(Date.parse(slotsA[0].startUtc) + 60_000).toISOString(),
    }),
  });
  ok(
    "horario no ofrecido → 409 slot_not_offered (código EXACTO)",
    noOfrecido.res.status === 409 &&
      noOfrecido.json?.error?.code === "slot_not_offered",
    `status=${noOfrecido.res.status} body=${JSON.stringify(noOfrecido.json)}`
  );
  ok(
    "y devuelve lo que SÍ se ofreció, para re-ofrecer sin inventar",
    (noOfrecido.json?.slots ?? []).length > 0
  );

  // Caminho feliz: 201 EXATO, não 200.
  const elegido = slotsA[0].startUtc;
  const creada = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convA.id, startUtc: elegido }),
  });
  ok(
    "reservar responde 201 Created (NO 200): es contrato",
    creada.res.status === 201,
    `status=${creada.res.status}`
  );
  ok(
    "la respuesta trae etiqueta y el enlace de la sala fija",
    creada.json?.label && creada.json?.meetingLink === SALA,
    JSON.stringify(creada.json)
  );
  ok("el enlace no queda pendiente con el conector soberano", creada.json?.linkPending === false);

  const dispTrasReserva = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok(
    "el hueco reservado desaparece de la disponibilidad",
    !dispTrasReserva.some((s) => s.startUtc === elegido)
  );

  const lista = (await api("/api/bookings")).json?.bookings ?? [];
  ok(
    "la cita aparece en Citas, marcada como agendada por la IA",
    lista.some((b) => b.id === creada.json?.bookingId && b.source === "ai"),
    JSON.stringify(lista.map((b) => ({ id: b.id, source: b.source })))
  );

  /**
   * O contexto do cérebro SABE do agendamento.
   *
   * Sem isso, um cérebro externo só conhece o agendamento pelo histórico, e na
   * edição cloud isso acabou em um segundo agendamento para quem não chegou à
   * primeira e em «tu demo es hoy a las 10:30» dito à tarde. A Nea lê este
   * bloco tal como está; a raiz não o mandava.
   */
  const ctxConCita = await bot(`/api/bot/context?conversationId=${convA.id}`);
  const proxima = ctxConCita.json?.booking?.next;
  ok(
    "el contexto del cerebro trae la cita que viene: id, instante UTC y estado",
    proxima?.id === creada.json?.bookingId &&
      proxima?.startUtc === elegido &&
      proxima?.status === "agendada" &&
      proxima?.endUtc === new Date(Date.parse(elegido) + 30 * 60_000).toISOString(),
    JSON.stringify(ctxConCita.json?.booking)
  );
  ok(
    "…con la etiqueta del día en palabras, en la zona del negocio",
    ctxConCita.json?.booking?.timezone === "America/Mexico_City" &&
      typeof proxima?.label === "string" &&
      proxima.label.endsWith(`, ${slotsA[0].time}`) &&
      proxima.label.length > `, ${slotsA[0].time}`.length + 8,
    `label=${JSON.stringify(proxima?.label)} time=${slotsA[0].time}`
  );
  ok(
    "…y con el enlace que se le dio al cliente",
    proxima?.meetingLink === SALA && proxima?.linkPending === false,
    JSON.stringify({ meetingLink: proxima?.meetingLink, linkPending: proxima?.linkPending })
  );

  // GARANTIA 2: a corrida. B tinha o mesmo vão ofertado e chega tarde.
  const ofertaB = await bot(
    `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
  );
  // Oferece-se a B exatamente o vão que A acabou de tomar: simula-se a
  // oferta anterior à reserva de A, que é como acontece na vida real.
  const tomado = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convB.id, startUtc: elegido }),
  });
  ok(
    "el hueco ya tomado → 409 (nunca una segunda cita)",
    tomado.res.status === 409,
    `status=${tomado.res.status} body=${JSON.stringify(tomado.json)}`
  );
  ok(
    "el sobre del error va ANIDADO y `slots` es HERMANO",
    typeof tomado.json?.error?.code === "string" && Array.isArray(tomado.json?.slots),
    JSON.stringify(tomado.json)
  );

  const listaTrasCarrera = (await api("/api/bookings")).json?.bookings ?? [];
  const activasEnElHueco = listaTrasCarrera.filter(
    (b) =>
      b.scheduledAtUtc === elegido &&
      (b.status === "agendada" || b.status === "realizada")
  );
  ok(
    "CERO doble-agendamiento: una sola cita activa en ese instante",
    activasEnElHueco.length === 1,
    `activas=${activasEnElHueco.length}`
  );

  // As alternativas do 409 já são a oferta vigente: reserváveis de imediato.
  const alternativa = (tomado.json?.slots ?? [])[0];
  if (alternativa) {
    const conAlternativa = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convB.id,
        startUtc: alternativa.startUtc,
      }),
    });
    ok(
      "una alternativa del 409 se reserva de inmediato (201)",
      conAlternativa.res.status === 201,
      `status=${conAlternativa.res.status}`
    );
  } else {
    ok("el 409 trajo alternativas frescas", false, "lista vacía");
  }

  // Remarcar pela superfície do bot: 200, não 201.
  const ofertaMover = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const destino = (ofertaMover.json?.slots ?? [])[0];
  if (destino) {
    const movida = await bot("/api/bot/bookings", {
      method: "PATCH",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: destino.startUtc,
      }),
    });
    ok(
      "reprogramar responde 200 (NO 201): no crea un recurso nuevo",
      movida.res.status === 200,
      `status=${movida.res.status}`
    );
    const ctxMovida = (await bot(`/api/bot/context?conversationId=${convA.id}`)).json
      ?.booking?.next;
    ok(
      "el contexto sigue a la cita movida: la MISMA cita, en su instante nuevo",
      ctxMovida?.id === creada.json?.bookingId && ctxMovida?.startUtc === destino.startUtc,
      JSON.stringify(ctxMovida)
    );
  }

  /**
   * A falha de INTEGRAÇÃO do issue #50.
   *
   * Tudo o de cima entra por `/api/bot/*`, onde quem chama JÁ tem o
   * ISO. O agente INCORPORADO não o tinha: ao modelo só chegavam o prompt
   * e o histórico de TEXTO, com os rótulos que o cliente leu e sem ano,
   * fuso nem data de hoje. Acertar o instante era sorte, a recusa caía em
   * `slot_not_offered` —de texto fixo— e a conversa repetia a lista
   * para sempre.
   *
   * E por isso este self-test não a pegava: o resto de 015 exercita o
   * gateway, nunca a conversa. Aqui é preciso LIGAR o agente
   * in-process de propósito, e desligá-lo depois para não alterar o que vem.
   */
  console.log("\n== 015: el agente reserva desde la conversación (#50) ==");
  {
    await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    const encendido = await api("/api/agent/profile");
    ok(
      "el agente in-process queda encendido para esta prueba",
      encendido.json?.profile?.enabled === true,
      JSON.stringify(encendido.json?.profile?.enabled)
    );

    /**
     * Contato NOVO em cada execução.
     *
     * Com um telefone fixo, a segunda execução arrasta a conversa e —
     * sobretudo— as OFERTAS da anterior: o mapa já está ali desde a
     * primeira mensagem e o agente reserva antes de ofertar, então a checagem
     * mede outra coisa. O resto do roteiro assume base recém-semeada; esta
     * seção não pode se dar a esse luxo porque compara ANTES e DEPOIS.
     */
    const CORRIDA = Date.now().toString().slice(-6);
    const LEAD_C = `5214627${CORRIDA}`;
    const decir = (texto, n) =>
      api("/api/dev/wa-mock/inbound", {
        method: "POST",
        body: JSON.stringify({
          phoneNumberId: PN,
          from: LEAD_C,
          name: "Lead agenda C",
          text: texto,
          // Único por execução: com um id fixo, a segunda execução o
          // deduplica na ingestão e não entra NADA — o agente não chega a
          // rodar e a checagem falha sem que haja nada quebrado.
          waMessageId: `wamid.e2e.015.c.${CORRIDA}.${n}`,
        }),
      });

    await decir("quiero agendar una cita", 1);
    await hasta(async () => {
      const cs = (await api("/api/conversations")).json?.conversations ?? [];
      return cs.some((c) => c.contact.phone === `524627${CORRIDA}`);
    });

    const convs = (await api("/api/conversations")).json?.conversations ?? [];
    const convC = convs.find((c) => c.contact.phone === `524627${CORRIDA}`);
    ok("el agente atendió al lead que pide cita", Boolean(convC));

    if (convC) {
      const salientesDe = async () => {
        const msgs =
          (await api(`/api/conversations/${convC.id}/messages`)).json
            ?.messages ?? [];
        return msgs.filter((m) => m.direction === "out");
      };

      // O agente tem que RESPONDER; quanto demore não é assunto da checagem.
      await hasta(async () => (await salientesDe()).length > 0);
      const trasOferta = await salientesDe();
      ok(
        "el agente OFRECE horarios (hay respuesta, no silencio)",
        trasOferta.length > 0 && /\d{2}:\d{2}/.test(trasOferta.at(-1)?.text ?? ""),
        `salientes=${trasOferta.length} ultimo=${(trasOferta.at(-1)?.text ?? "").slice(0, 80)}`
      );

      const antes = (await api("/api/bookings")).json?.bookings ?? [];
      await decir("quiero el primero", 2);
      await hasta(async () => {
        const bs = (await api("/api/bookings")).json?.bookings ?? [];
        return bs.length > antes.length;
      });

      const despues = (await api("/api/bookings")).json?.bookings ?? [];
      ok(
        "elegir un horario CREA la cita (no repite la lista)",
        despues.length > antes.length,
        `citas antes=${antes.length} despues=${despues.length}`
      );

      /**
       * Aqui havia uma terceira verificação —«confirma em vez de voltar a
       * ofertar»— e foi removida: passava TAMBÉM com o bug, porque sob a
       * falha o agente responde qualquer outra coisa que também não contém
       * «estes horários». Uma verificação que não distingue a falha do
       * acerto só dá confiança falsa. O que decide é o agendamento criado.
       */
    }

    await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
  }

  console.log("\n== 015: el operador y el enlace pendiente (US4) ==");
  const bookingId = creada.json?.bookingId;
  const cancelada1 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  const cancelada2 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  ok(
    "cancelar dos veces no falla (idempotente)",
    cancelada1.res.ok && cancelada2.res.ok,
    `${cancelada1.res.status}/${cancelada2.res.status}`
  );

  /**
   * E o contexto diz que foi CANCELADO, e por quem.
   *
   * Na edição cloud, sem isso, o agente respondeu a um cliente cuja
   * demo a equipe cancelou «no quedó guardada, por alguna razón»: via o
   * agendamento no histórico e não no contexto, e inventou o motivo.
   */
  const ctxCancelada = (await bot(`/api/bot/context?conversationId=${convA.id}`)).json
    ?.booking;
  ok(
    "cancelada desde el panel, el contexto ya no la da por vigente",
    Boolean(ctxCancelada) && ctxCancelada.next?.id !== bookingId,
    JSON.stringify(ctxCancelada?.next)
  );
  ok(
    "…y la trae como cancelada por el equipo, sin enlace",
    ctxCancelada?.lastClosed?.id === bookingId &&
      ctxCancelada.lastClosed.status === "cancelada" &&
      ctxCancelada.lastClosed.cancelledBy === "equipo" &&
      typeof ctxCancelada.lastClosed.closedAt === "string" &&
      !("meetingLink" in ctxCancelada.lastClosed),
    JSON.stringify(ctxCancelada?.lastClosed)
  );

  const reintentoInvalido = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "retry_link" }),
  });
  ok(
    "reintentar el enlace de una cita que sí lo tiene → 422",
    reintentoInvalido.res.status === 422,
    `status=${reintentoInvalido.res.status}`
  );

  // O conector caído: o agendamento É CRIADO mesmo assim, com o link pendente.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "zoom" }),
  });
  const ofertaPend = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotPend = (ofertaPend.json?.slots ?? [])[0];
  if (slotPend) {
    const sinProveedor = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: slotPend.startUtc,
      }),
    });
    ok(
      "con el proveedor sin conectar, la cita SE CREA igual (201)",
      sinProveedor.res.status === 201,
      `status=${sinProveedor.res.status}`
    );
    ok(
      "…y avisa que el enlace queda pendiente, en vez de prometerlo",
      sinProveedor.json?.linkPending === true &&
        sinProveedor.json?.meetingLink === null,
      JSON.stringify(sinProveedor.json)
    );

    const listaPend = (await api("/api/bookings")).json?.bookings ?? [];
    ok(
      "la cita sin enlace se ve como tal en Citas",
      listaPend.some(
        (b) => b.id === sinProveedor.json?.bookingId && b.linkPending === true
      )
    );
  }

  // Restaura-se o conector soberano para não deixar a instância pela metade.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "enlace-fijo" }),
  });

  console.log("\n== 015: conector Zoom contra su mock ==");
  const zoomMockUp = await fetch(`${BASE}/api/dev/zoom-mock/_state`);
  if (!zoomMockUp.ok) {
    console.log("  (zoom-mock no disponible: se omiten los checks del conector)");
  } else {
    await fetch(`${BASE}/api/dev/zoom-mock/_reset`, { method: "POST" });

    const malas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-invalid",
      }),
    });
    ok(
      "credenciales que el proveedor rechaza NO se guardan (422)",
      malas.res.status === 422,
      `status=${malas.res.status}`
    );
    ok(
      "…y la conexión sigue sin existir",
      (await api("/api/settings/zoom")).json?.connection === null
    );

    const buenas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-bueno",
      }),
    });
    ok("credenciales válidas se guardan", buenas.res.ok, `status=${buenas.res.status}`);
    ok(
      "hacia el navegador solo salen los últimos 4 del secreto",
      buenas.json?.connection?.secretLast4 === "ueno" &&
        !JSON.stringify(buenas.json).includes("secreto-bueno"),
      JSON.stringify(buenas.json)
    );

    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "zoom" }),
    });
    const ofertaZoom = await bot(
      `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
    );
    const slotZoom = (ofertaZoom.json?.slots ?? [])[0];
    if (slotZoom) {
      const conZoom = await bot("/api/bot/bookings", {
        method: "POST",
        body: JSON.stringify({
          conversationId: convB.id,
          startUtc: slotZoom.startUtc,
        }),
      });
      ok(
        "agendar con Zoom crea la reunión y devuelve su enlace",
        conZoom.res.status === 201 &&
          typeof conZoom.json?.meetingLink === "string" &&
          conZoom.json.meetingLink.includes("zoom.mock"),
        JSON.stringify(conZoom.json)
      );

      const estado = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        "el proveedor recibió la reunión con su tema y su hora",
        estado.meetings?.length === 1 &&
          estado.meetings[0].topic.startsWith("Cita —"),
        JSON.stringify(estado.meetings)
      );

      // Cancelar apaga a reunião no provedor.
      await api(`/api/bookings/${conZoom.json.bookingId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
      const estado2 = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        "cancelar la cita borra la reunión en el proveedor",
        (estado2.deleted ?? []).length === 1,
        JSON.stringify(estado2)
      );
    }

    await api("/api/settings/zoom", { method: "DELETE" });
    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "enlace-fijo" }),
    });
  }

  await huecosPorFechaChecks();

  // O sandbox do Laboratório (um agendamento de teste jamais chega a um conector)
  // NÃO é verificado aqui: as conversas do Laboratório não são alcançáveis
  // pela API pública —de propósito—, então de fora só poderia
  // ser observado por ausência, que é uma prova fraca. Vive em
  // `tests/unit/agenda-sandbox.test.ts`, que afirma o que de fato importa:
  // que o conector não é chamado, nem ao criar, nem ao remarcar, nem ao
  // cancelar.
}

/* ============================================================
 * R10 — Horários livres por data (tests/e2e/us-agenda.md, US3b)
 *
 * A falha que o motivou, na prova de ponta a ponta raiz + Nea: a
 * «¿tienen algo mañana en la tarde?» o cérebro só recebia as três
 * primeiras horas da manhã e respondeu que só havia manhã. Aqui se pede o
 * dia com `date`, reserva-se um horário da TARDE e confere-se que a
 * divisão sem `date` conserva sua forma. Roda no final de 015 com um lead
 * próprio: não toca a oferta dos outros.
 * ============================================================ */
async function huecosPorFechaChecks() {
  console.log("\n== R10: huecos por fecha (la tarde de mañana) ==");
  const tz = (await api("/api/calendar/settings")).json?.settings?.timezone;
  const diaEn = (offsetDias) => {
    const hoy = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return new Date(Date.parse(`${hoy}T00:00:00Z`) + offsetDias * 86_400_000)
      .toISOString()
      .slice(0, 10);
  };
  const manana = diaEn(1);

  const SUF = Date.now().toString().slice(-6);
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: `5214629${SUF}`,
      name: "Lead R10 tarde",
      // Sem palavras que disparem o agente incluído a ofertar ou reservar.
      text: "¿tienen algo mañana en la tarde?",
      waMessageId: `wamid.e2e.r10.${SUF}.1`,
    }),
  });
  let conv = null;
  await hasta(async () => {
    const cs = (await api("/api/conversations")).json?.conversations ?? [];
    conv = cs.find((c) => c.contact.phone === `524629${SUF}`) ?? null;
    return Boolean(conv);
  });
  ok("conversación del lead que pide la tarde", Boolean(conv));
  if (!conv) return;
  const q = `/api/bot/availability?conversationId=${conv.id}&limit=12&perDay=3&days=5`;

  // Sem date: a forma de sempre (+ query), e o porquê da falha à vista.
  const reparto = await bot(q);
  const rSlots = reparto.json?.slots ?? [];
  ok(
    "sin date: la misma forma (slots + diasConAgenda) y ahora query",
    reparto.res.status === 200 &&
      Array.isArray(reparto.json?.diasConAgenda) &&
      rSlots.length > 0 &&
      ["startUtc", "endUtc", "label", "dayIso", "dayLabel", "time"].every(
        (k) => k in rSlots[0]
      ),
    `status=${reparto.res.status} keys=${Object.keys(reparto.json ?? {})}`
  );
  ok(
    "sin date: query dice que es un reparto y hasta dónde revisó",
    reparto.json?.query?.date === null &&
      reparto.json?.query?.perDay === 3 &&
      /^\d{4}-\d{2}-\d{2}$/.test(reparto.json?.query?.coveredUntil ?? "") &&
      /^\d{4}-\d{2}-\d{2}$/.test(reparto.json?.query?.horizonEnd ?? ""),
    JSON.stringify(reparto.json?.query)
  );

  // Com date: TODO o dia de amanhã, inclusive a tarde.
  const delDia = await bot(`${q}&date=${manana}`);
  const dSlots = delDia.json?.slots ?? [];
  ok(
    "con date: 200 con query.date = el día pedido y status available",
    delDia.res.status === 200 &&
      delDia.json?.query?.date === manana &&
      delDia.json?.query?.status === "available",
    `status=${delDia.res.status} query=${JSON.stringify(delDia.json?.query)}`
  );
  ok(
    "con date: solo horas de ese día, más de las 3 del reparto",
    dSlots.length > 3 && dSlots.every((s) => s.dayIso === manana),
    `n=${dSlots.length}`
  );
  const tarde = dSlots.find((s) => s.time >= "15:00");
  ok(
    "con date: trae la TARDE (lo que el reparto no enseñaba)",
    Boolean(tarde),
    JSON.stringify(dSlots.map((s) => s.time))
  );

  // Consultas que não encontram nada NÃO apagam a oferta vigente.
  const lejos = diaEn(8);
  const fuera = await bot(`${q}&date=${lejos}`);
  ok(
    "un día más allá del horizonte → beyond_horizon, sin horas",
    fuera.res.status === 200 &&
      fuera.json?.query?.status === "beyond_horizon" &&
      (fuera.json?.slots ?? []).length === 0,
    `status=${fuera.res.status} query=${JSON.stringify(fuera.json?.query)}`
  );
  const mala = await bot(`${q}&date=2026-02-31`);
  ok(
    "una fecha inexistente → 422 invalid_body (no 500)",
    mala.res.status === 422 && mala.json?.error?.code === "invalid_body",
    `status=${mala.res.status}`
  );

  if (!tarde) return;
  const reserva = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: conv.id, startUtc: tarde.startUtc }),
  });
  ok(
    "reservar una hora de la tarde ofrecida por fecha → 201",
    reserva.res.status === 201 && Boolean(reserva.json?.bookingId),
    `status=${reserva.res.status} body=${JSON.stringify(reserva.json)}`
  );
  ok(
    "la cita queda a la hora de la tarde elegida",
    typeof reserva.json?.label === "string" && reserva.json.label.includes(tarde.time),
    JSON.stringify(reserva.json?.label)
  );
  const otraVez = await bot(`${q}&date=${manana}`);
  ok(
    "la hora reservada ya no se ofrece para ese día",
    !(otraVez.json?.slots ?? []).some((s) => s.startUtc === tarde.startUtc),
    `n=${(otraVez.json?.slots ?? []).length}`
  );
}

main().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});

/* ============================================================
 * 016 — Atribuição de anúncios e Conversions API (tests/e2e/us-atribucion.md)
 *
 * Cobre as duas configurações da flag, a conexão do dataset, a
 * captura do anúncio, os dois eventos com o FORMATO do seu payload, o dedup,
 * e —o que mais importa— que uma falha da Meta jamais custa a movimentação do
 * lead.
 *
 * Os contatos levam um sufixo por execução: o dedup de conversões é
 * permanente por design, então rodar o harness de novo contra a MESMA base
 * tem que estrear leads ou estaria medindo os da execução anterior.
 * ============================================================ */

async function atribucionChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.ATRIBUCION ?? "").trim()
  );
  const SUF = String(Date.now()).slice(-6);
  const tel = (n) => `52155${SUF}${n}`;
  const nom = (base) => `${base} ${SUF}`;

  console.log("\n== 016: la bandera de la atribución ==");

  if (!encendida) {
    for (const ruta of ["/api/settings/capi", "/api/settings/capi/events"]) {
      const { res } = await api(ruta);
      ok(
        `${ruta} → 404 con la atribución apagada`,
        res.status === 404,
        `status=${res.status}`
      );
    }
    const put = await api("/api/settings/capi", {
      method: "PUT",
      body: JSON.stringify({ datasetId: "ds-e2e" }),
    });
    ok(
      "PUT /api/settings/capi → 404 con la atribución apagada",
      put.res.status === 404,
      `status=${put.res.status}`
    );
    const page = await fetch(`${BASE}/settings/ads`, { headers: { cookie } });
    ok(
      "la pantalla /settings/ads no existe",
      page.status === 404,
      `status=${page.status}`
    );

    // E uma mensagem que VEM de um anúncio é atendida como qualquer outra:
    // a instância que não atribui não fica sabendo do referral, mas também não
    // quebra com ele.
    const inb = await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: tel("1"),
        name: nom("Lead con anuncio apagada"),
        text: "vi su anuncio",
        ctwaClid: "clid-apagada",
        waMessageId: `wamid.e2e.016.off.${SUF}`,
      }),
    });
    ok("inbound con anuncio entregado igual", inb.res.ok);
    // Com `preview` a mensagem já entrou, e o anúncio é salvo antes dela.
    let convOff = null;
    await hasta(async () => {
      const convs = (await api("/api/conversations")).json?.conversations ?? [];
      convOff = convs.find(
        (c) => c.contact.name === nom("Lead con anuncio apagada") && c.preview != null
      );
      return !!convOff;
    });
    ok("la conversación del anuncio existe (la ingesta no se rompe)", !!convOff);
    // 018 — A flag já não esconde DE QUAL anúncio chegou: isso se vê sempre.
    // O que desliga é o identificador de clique, que nem é salvo.
    ok(
      "el origen del anuncio se ve igual con la bandera apagada (018)",
      convOff?.anuncio?.headline === "Anuncio de prueba",
      JSON.stringify(convOff?.anuncio)
    );
    const detalleOff = convOff
      ? (await api(`/api/contacts/${convOff.contact.id}`)).json
      : null;
    ok(
      "pero sin identificador de clic: hasCtwaClid es false y el valor no aparece",
      detalleOff?.anuncio?.hasCtwaClid === false &&
        !JSON.stringify(detalleOff).includes("clid-apagada"),
      JSON.stringify(detalleOff?.anuncio)
    );
    console.log(
      "  (atribución apagada: el resto de los checks de 016 no aplican)"
    );
    return;
  }

  /* ---------------- US2: conectar o dataset ---------------- */

  console.log("\n== 016: conectar el dataset (US2) ==");
  // Parte-se do desconectado: assim a primeira checagem afirma o que diz
  // afirmar, mesmo que o harness seja rerrodado sobre a mesma base.
  await api("/api/settings/capi", { method: "DELETE" });
  const vacio = await api("/api/settings/capi");
  ok(
    "sin configurar responde 200 con capi: null (no 404)",
    vacio.res.status === 200 && vacio.json?.capi === null,
    JSON.stringify(vacio.json)
  );

  const board0 = (await api("/api/pipeline/board")).json;
  const etapaCalificado = board0.stages.filter((s) => s.kind === "open").at(-1);
  const etapaGanada = board0.stages.find((s) => s.kind === "won");
  const etapaInicial = board0.stages.find((s) => s.kind === "open");

  const etapaAjena = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: "stg_de_otro_negocio",
    }),
  });
  ok(
    "una etapa que no es del negocio se rechaza con 422 etapa_invalida",
    etapaAjena.res.status === 422 &&
      etapaAjena.json?.error?.code === "etapa_invalida",
    `status=${etapaAjena.res.status} ${JSON.stringify(etapaAjena.json)}`
  );

  const guardado = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  ok(
    "se guarda el dataset sin pegar token",
    guardado.res.ok,
    `status=${guardado.res.status}`
  );

  const cfg = (await api("/api/settings/capi")).json?.capi;
  ok(
    "reusó el token de WhatsApp y solo muestra sus últimos 4",
    cfg?.datasetId === "ds-e2e" && cfg?.tokenLast4 === "-e2e",
    JSON.stringify(cfg)
  );
  ok(
    "el token completo NUNCA sale del servidor",
    !JSON.stringify(cfg).includes("tok-e2e"),
    JSON.stringify(cfg)
  );

  /* ---------------- US3 + US4: capturar e qualificar ---------------- */

  console.log("\n== 016: del anuncio al lead calificado (US3/US4) ==");
  await api("/api/dev/wa-mock/capi-events", { method: "DELETE" });

  const CLID = `clid-e2e-${SUF}`;
  const NOMBRE_AD = nom("Lead de anuncio");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "hola, vengo del anuncio",
      ctwaClid: CLID,
      adHeadline: "Kit de verano",
      waMessageId: `wamid.e2e.016.ad.${SUF}.1`,
    }),
  });
  await sleep(1400);

  // Segunda mensagem com OUTRO referral: o primeiro vence e não é sobrescrito.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "sigo aquí",
      ctwaClid: "clid-que-no-debe-ganar",
      waMessageId: `wamid.e2e.016.ad.${SUF}.2`,
    }),
  });
  await sleep(1200);

  const board1 = (await api("/api/pipeline/board")).json;
  const leadAd = board1.leads.find((l) => l.contact.name === NOMBRE_AD);
  ok("el lead del anuncio existe en el tablero", !!leadAd);

  const mov1 = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "el lead se mueve a la etapa calificada",
    mov1.res.ok,
    `status=${mov1.res.status}`
  );
  await sleep(800);

  const act1 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const calificado = act1.find(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "se reportó QualifiedLead con acuse de Meta",
    calificado?.status === "sent" && !!calificado?.fbTraceId,
    JSON.stringify(calificado)
  );
  ok(
    "la actividad dice de qué anuncio vino",
    calificado?.adHeadline === "Kit de verano",
    JSON.stringify(calificado)
  );

  const capi1 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento1 = capi1.find((e) => e.eventName === "QualifiedLead");
  ok(
    "el evento viajó con el ctwa_clid del PRIMER referral",
    evento1?.ctwaClid === CLID,
    JSON.stringify(evento1?.ctwaClid)
  );
  ok(
    "y con custom_data.lead_stage (lo único reglable en Meta)",
    evento1?.customData?.lead_stage === "qualified",
    JSON.stringify(evento1?.customData)
  );

  // Dedup: tirá-lo e colocá-lo de novo não reenvia.
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaInicial.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act2 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const califsDeEste = act2.filter(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "volver a calificar NO reporta dos veces",
    califsDeEste.length === 1,
    `${califsDeEste.length} filas`
  );

  /* ---------------- US5: a venda ---------------- */

  console.log("\n== 016: la venta (US5) ==");
  const venta = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      stageId: etapaGanada.id,
      amountCents: 45050,
      currency: "MXN",
    }),
  });
  ok("el trato se marca como ganado", venta.res.ok, `status=${venta.res.status}`);
  await sleep(800);

  const act3 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const compra = act3.find(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok("se reportó la venta", compra?.status === "sent", JSON.stringify(compra));

  const capi2 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento2 = capi2.find((e) => e.eventName === "Purchase");
  ok(
    "la venta viajó en UNIDADES de la moneda, no en centavos",
    evento2?.customData?.value === 450.5 &&
      evento2?.customData?.currency === "MXN",
    JSON.stringify(evento2?.customData)
  );

  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaGanada.id }),
  });
  await sleep(800);
  const act4 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const comprasDeEste = act4.filter(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok(
    "re-ganar NO manda una segunda compra (a Meta no se le des-envía nada)",
    comprasDeEste.length === 1,
    `${comprasDeEste.length} filas`
  );

  /* ---------------- Os caminhos infelizes ---------------- */

  console.log("\n== 016: caminos infelices ==");

  // Um lead que não veio de um anúncio: registra-se o motivo e nada falha.
  const NOMBRE_ORG = nom("Lead organico");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("3"),
      name: NOMBRE_ORG,
      text: "hola",
      waMessageId: `wamid.e2e.016.org.${SUF}`,
    }),
  });
  await sleep(1400);
  const board2 = (await api("/api/pipeline/board")).json;
  const leadOrg = board2.leads.find((l) => l.contact.name === NOMBRE_ORG);
  await api(`/api/pipeline/leads/${leadOrg.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act5 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const omitido = act5.find((e) => e.contactName === NOMBRE_ORG);
  ok(
    "un lead sin anuncio queda OMITIDO con el motivo escrito",
    omitido?.status === "skipped" && /ctwa_clid/.test(omitido?.error ?? ""),
    JSON.stringify(omitido)
  );

  // Meta recusando: o 200 mentiroso (events_received: 0).
  const NOMBRE_FAIL = nom("Lead con Meta caido");
  await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e-fail",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("4"),
      name: NOMBRE_FAIL,
      text: "vengo del anuncio",
      ctwaClid: `clid-fail-${SUF}`,
      waMessageId: `wamid.e2e.016.fail.${SUF}`,
    }),
  });
  await sleep(1400);
  const board3 = (await api("/api/pipeline/board")).json;
  const leadFail = board3.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  const movFail = await api(`/api/pipeline/leads/${leadFail.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "con Meta rechazando, el lead SE MUEVE igual",
    movFail.res.ok,
    `status=${movFail.res.status}`
  );
  await sleep(800);
  const board4 = (await api("/api/pipeline/board")).json;
  const leadFail2 = board4.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  ok(
    "y se queda en la etapa a la que lo movieron",
    leadFail2?.stageId === etapaCalificado.id,
    JSON.stringify(leadFail2?.stageId)
  );
  const act6 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const fallido = act6.find((e) => e.contactName === NOMBRE_FAIL);
  ok(
    "la fila queda FALLIDA con lo que dijo Meta (200 pero events_received=0)",
    fallido?.status === "failed" &&
      /events_received=0/.test(fallido?.error ?? ""),
    JSON.stringify(fallido)
  );

  // Desconectar: deixa de ser reportado, mas o registro do que já foi dito fica.
  const del = await api("/api/settings/capi", { method: "DELETE" });
  ok("se puede desconectar", del.res.ok);
  const trasBorrar = (await api("/api/settings/capi")).json;
  ok("tras desconectar, no hay configuración", trasBorrar?.capi === null);
  const act7 = (await api("/api/settings/capi/events")).json?.events ?? [];
  ok(
    "los eventos ya reportados NO se borran al desconectar",
    act7.length >= 3,
    `${act7.length} filas`
  );
}

/* ============================================================
 * 018 — De qual anúncio chegou cada conversa (tests/e2e/us-atribucion.md)
 *
 * Roda com a flag ATRIBUCION desligada E ligada: a origem do anúncio
 * se vê sempre, e a única coisa que muda é se a Meta identificou o clique. Porta
 * das seções 1-4b do roteiro da spec 212 do Vocero Cloud, sem as
 * verificações entre organizações (aqui há uma).
 *
 * Os criativos são servidos pelo wa-mock (`/api/dev/wa-mock/media-file/creativo-*`),
 * na origem de META_GRAPH_BASE_URL: a única que a cópia aceita fora dos
 * hosts da Meta, e só com os mocks habilitados.
 * ============================================================ */

async function anuncioDeOrigenChecks() {
  const atribuye = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.ATRIBUCION ?? "").trim()
  );
  const RUN = String(Date.now()).slice(-6);
  const tel = (n) => `52156${RUN}${String(n).padStart(2, "0")}`;
  const nombre = (n) => `Anuncio ${RUN} ${n}`;
  let origenMock = BASE;
  try {
    origenMock = new URL(process.env.META_GRAPH_BASE_URL).origin;
  } catch {
    /* sem META_GRAPH_BASE_URL: o próprio BASE */
  }
  const creativo = (id) => `${origenMock}/api/dev/wa-mock/media-file/${id}`;
  const referralCtwa = ({ id, titular, imagen, tipo = "ad" }) => ({
    source_url: `https://fb.me/anuncio-${RUN}-${id}`,
    source_id: `1202${RUN}${id}`,
    source_type: tipo,
    headline: titular,
    body: `Texto del anuncio ${id}`,
    media_type: "image",
    image_url: imagen,
    ctwa_clid: `clid-018-${RUN}-${id}`,
  });
  const entra = (n, texto, referral, waMessageId = `wamid.e2e.018.${RUN}.${n}`) =>
    api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: tel(n),
        name: nombre(n),
        text: texto,
        waMessageId,
        ...(referral ? { referral } : {}),
      }),
    });
  // O webhook processa em `after()`: a conversa existe um instante antes
  // que seu anúncio e sua mensagem. Com `preview` já há mensagem, e o anúncio
  // é salvo ANTES da mensagem: a partir daí o que a lista diz é final.
  const conversacionDe = async (n) => {
    let hallada = null;
    await hasta(async () => {
      const convs = (await api("/api/conversations")).json?.conversations ?? [];
      hallada =
        convs.find((c) => c.contact.name === nombre(n) && c.preview != null) ?? null;
      return !!hallada;
    });
    return hallada;
  };
  const detalle = async (contactId) =>
    (await api(`/api/contacts/${contactId}`)).json;
  const imagenDe = async (contactId, ms = 15000) => {
    let id = null;
    await hasta(async () => {
      id = (await detalle(contactId))?.anuncio?.imageAssetId ?? null;
      return !!id;
    }, ms);
    return id;
  };

  console.log(
    `\n== 018: de qué anuncio llegó (ATRIBUCION ${atribuye ? "encendida" : "apagada"}) ==`
  );
  // No `next dev` uma rota é compilada na sua primeira requisição, e isso pode demorar
  // mais que a espera da cópia: aquecem-se antes de medir.
  await fetch(creativo("creativo-calentamiento")).catch(() => null);
  await api("/api/media/calentamiento").catch(() => null);

  /* ---------- 1 · a primeira mensagem traz seu anúncio ---------- */
  const R1 = referralCtwa({ id: 1, titular: `Diagnóstico gratis ${RUN}`, imagen: creativo(`creativo-azul-${RUN}`) });
  const R2 = referralCtwa({ id: 2, titular: `Segundo anuncio ${RUN}`, imagen: creativo(`creativo-rojo-${RUN}`) });
  const inb1 = await entra(1, `Hola, vi su anuncio ${RUN}`, R1);
  ok("el webhook acepta el mensaje con referral", inb1.res.ok, `status=${inb1.res.status}`);
  const conv1 = await conversacionDe(1);
  ok(
    "la lista trae el anuncio con su titular",
    conv1?.anuncio?.headline === R1.headline &&
      conv1?.anuncio?.sourceId === R1.source_id &&
      conv1?.anuncio?.sourceType === "ad",
    JSON.stringify(conv1?.anuncio)
  );
  const d1 = conv1 ? await detalle(conv1.contact.id) : null;
  const an = d1?.anuncio;
  ok(
    "el detalle del contacto trae el anuncio completo",
    an?.sourceId === R1.source_id && an?.sourceType === "ad" &&
      an?.sourceUrl === R1.source_url && an?.body === R1.body &&
      an?.mediaType === "image" && !!an?.capturedAt,
    JSON.stringify(an)
  );
  ok(
    atribuye
      ? "con la bandera encendida, Meta identificó el clic (hasCtwaClid)"
      : "con la bandera apagada, no hay clic que identificar (hasCtwaClid false)",
    an?.hasCtwaClid === atribuye,
    JSON.stringify(an)
  );
  const lista1 = (await api("/api/conversations")).json;
  ok(
    "el ctwa_clid no sale por la API",
    !JSON.stringify(d1 ?? {}).includes(R1.ctwa_clid) &&
      !JSON.stringify(lista1 ?? {}).includes(R1.ctwa_clid),
    "¡la respuesta traía el identificador de clic!"
  );
  ok(
    "la fuente sin capturar se deduce «anuncio»",
    d1?.contact?.source?.value === "anuncio" &&
      d1?.contact?.source?.source === "deducida",
    JSON.stringify(d1?.contact?.source)
  );
  const imagenR1 = conv1 ? await imagenDe(conv1.contact.id) : null;
  ok("la imagen del creativo queda guardada", !!imagenR1, "imageAssetId siguió en null");
  if (imagenR1) {
    const media = await fetch(`${BASE}/api/media/${imagenR1}`, { headers: { cookie } });
    const bytes = Buffer.from(await media.arrayBuffer());
    ok(
      "y se sirve como PNG con sesión",
      media.status === 200 &&
        media.headers.get("content-type") === "image/png" &&
        bytes.subarray(1, 4).toString() === "PNG",
      `status ${media.status}, tipo ${media.headers.get("content-type")}, ${bytes.length} bytes`
    );
    const sinSesion = await fetch(`${BASE}/api/media/${imagenR1}`);
    ok("sin sesión no se sirve", sinSesion.status === 401, `status=${sinSesion.status}`);
  }

  /* ---------- 2 · o primeiro anúncio vence e nada se duplica ---------- */
  const entrantes = async () =>
    conv1
      ? ((await api(`/api/conversations/${conv1.id}/messages`)).json?.messages ?? [])
          .filter((m) => m.direction === "in").length
      : -1;
  const antes = await entrantes();
  // Reentrega exata da primeira mensagem, como faz a Meta, e uma segunda mensagem
  // da mesma pessoa a partir de OUTRO anúncio.
  await entra(1, `Hola, vi su anuncio ${RUN}`, R1);
  await entra(1, `Vi otro anuncio ${RUN}`, R2, `wamid.e2e.018.${RUN}.1b`);
  await hasta(async () => (await entrantes()) >= antes + 1);
  await sleep(600); // por via das dúvidas, caso a reentrega consiga entrar depois
  const despues = await entrantes();
  const conv1b = await conversacionDe(1);
  ok(
    "el segundo mensaje entra en la misma conversación y el anuncio sigue siendo el primero",
    conv1b?.id === conv1?.id && conv1b?.anuncio?.sourceId === R1.source_id,
    JSON.stringify({ id: conv1b?.id, anuncio: conv1b?.anuncio })
  );
  ok(
    "la reentrega no duplicó el mensaje",
    despues === antes + 1,
    `entrantes antes ${antes}, después ${despues} (se esperaba +1)`
  );

  /* ---------- 3 · a imagem é copiada uma vez por anúncio ---------- */
  await entra(3, `Otra persona, mismo anuncio ${RUN}`, { ...R1, ctwa_clid: `clid-otro-${RUN}` });
  const conv3 = await conversacionDe(3);
  const imagen3 = conv3 ? await imagenDe(conv3.contact.id) : null;
  ok(
    "otra conversación del mismo anuncio usa la misma imagen",
    !!imagenR1 && imagen3 === imagenR1,
    `imagen ${imagen3} vs ${imagenR1}`
  );

  /* ---------- 4 · o que não é baixado não quebra a ingestão ---------- */
  const casos = [
    { n: 4, nombre: "host que no es de Meta", imagen: "https://example.com/creativo.png" },
    { n: 5, nombre: "redirección a otro host", imagen: creativo("creativo-redirige") },
    { n: 6, nombre: "un SVG", imagen: creativo("creativo-svg") },
    { n: 7, nombre: "más de 300 KB", imagen: creativo("creativo-enorme") },
  ];
  for (const caso of casos) {
    await entra(caso.n, `Caso ${caso.n} ${RUN}`, referralCtwa({ id: 10 + caso.n, titular: `Caso ${caso.n} ${RUN}`, imagen: caso.imagen }));
    const conv = await conversacionDe(caso.n);
    ok(`${caso.nombre}: el mensaje y el anuncio entran`, !!conv?.anuncio, JSON.stringify(conv?.anuncio));
    caso.contactId = conv?.contact?.id;
  }
  await sleep(3000); // a cópia em segundo plano termina (ou não)
  for (const caso of casos) {
    const d = caso.contactId ? await detalle(caso.contactId) : null;
    ok(
      `${caso.nombre}: sin imagen, y la tarjeta sigue`,
      !!d?.anuncio && d.anuncio.imageAssetId === null,
      JSON.stringify(d?.anuncio)
    );
  }

  await entra(8, `Escribí sin anuncio ${RUN}`);
  const convOrg = await conversacionDe(8);
  const dOrg = convOrg ? await detalle(convOrg.contact.id) : null;
  ok(
    "una conversación orgánica no tiene anuncio",
    !!convOrg && convOrg.anuncio === null && dOrg?.anuncio === null &&
      dOrg?.contact?.source?.value === "desconocida",
    `lista ${JSON.stringify(convOrg?.anuncio)}, detalle ${JSON.stringify(dOrg?.anuncio)}`
  );

  await entra(9, `Referral sin datos ${RUN}`, { body: "sin nada que identifique", media_type: "image" });
  const convBasura = await conversacionDe(9);
  ok(
    "un referral sin nada útil no crea anuncio, y el mensaje entra",
    !!convBasura && convBasura.anuncio === null,
    JSON.stringify(convBasura?.anuncio)
  );

  await entra(10, `Desde una publicación ${RUN}`, referralCtwa({ id: 30, titular: `Publicación ${RUN}`, imagen: creativo(`creativo-verde-${RUN}`), tipo: "post" }));
  const convPub = await conversacionDe(10);
  const dPub = convPub ? await detalle(convPub.contact.id) : null;
  ok(
    "una publicación se enseña, pero no cuenta como fuente «anuncio»",
    convPub?.anuncio?.sourceType === "post" && dPub?.contact?.source?.value === "desconocida",
    `lista ${JSON.stringify(convPub?.anuncio)}, fuente ${JSON.stringify(dPub?.contact?.source)}`
  );

  /* ---------- 4b · um tropeço de rede não deixa o cartão sem imagem ---------- */
  // A primeira requisição demora mais que a espera da cópia: a nova tentativa a traz.
  await entra(13, `Creativo lento ${RUN}`, referralCtwa({ id: 40, titular: `Lento ${RUN}`, imagen: creativo(`creativo-lento-${RUN}`) }));
  const convLento = await conversacionDe(13);
  const imagenLenta = convLento ? await imagenDe(convLento.contact.id, 25000) : null;
  ok("una descarga que se cuelga una vez se reintenta y llega", !!imagenLenta, "la imagen no llegó tras el reintento");

  // Falha a cópia e sua nova tentativa (503 duas vezes): a repara abrir o contato.
  await entra(14, `Creativo que falla ${RUN}`, referralCtwa({ id: 41, titular: `Falla ${RUN}`, imagen: creativo(`creativo-falla-${RUN}`) }));
  const convFalla = await conversacionDe(14); // a lista não repara nada
  await sleep(4000);
  const primera = convFalla ? await detalle(convFalla.contact.id) : null;
  ok(
    "tras dos fallos la tarjeta llega sin imagen",
    !!primera?.anuncio && primera.anuncio.imageAssetId === null,
    JSON.stringify(primera?.anuncio)
  );
  const reparada = convFalla ? await imagenDe(convFalla.contact.id, 16000) : null;
  ok("y abrir el contacto la repara en segundo plano", !!reparada, "la imagen no se reparó");
}

/* ============================================================
 * R11 — Robustez da API do bot (seção autocontida)
 *
 * Cada parte diz o que quebrava antes. Tudo leva um sufixo por execução:
 * rerrodar contra a mesma base (ou dentro da janela do limitador) não
 * pode medir o que é da execução anterior.
 * ============================================================ */
async function r11BotChecks() {
  const RUN = Date.now().toString().slice(-6);

  /*
   * 1. Uma inundação sem key a partir de UMA IP não tira o turno do cérebro.
   *    Antes: um balde global contado ANTES de autenticar → 429 para a Nea pelo
   *    resto da janela, e clientes sem resposta.
   */
  console.log("\n== R11: 700 requests sin key desde una IP vs. el cerebro ==");
  const deReferencia = ((await api("/api/conversations")).json?.conversations ?? [])[0];
  ok("hay una conversación para que el cerebro pregunte", Boolean(deReferencia));
  // Um IP por execução: o da execução anterior pode seguir freado.
  const IP = `10.${Number(RUN.slice(0, 2))}.${Number(RUN.slice(2, 4))}.${Number(RUN.slice(4, 6))}`;
  const intento = (key, ip = IP) =>
    fetch(`${BASE}/api/bot/context?conversationId=${deReferencia?.id}`, {
      headers: { "x-forwarded-for": ip, ...(key ? { "x-api-key": key } : {}) },
    }).then((r) => r.status);
  const vistos = {};
  const cerebroDurante = [];
  for (let lote = 0; lote < 14; lote++) {
    const fallidos = Array.from({ length: 50 }, (_, i) =>
      intento(i % 2 ? "clave-equivocada-0123456789" : undefined)
    );
    // O cérebro pergunta NO MEIO da inundação, desde outro IP e desde
    // o mesmo (mesmo proxy, ou sem proxy onde tudo é "local").
    const cerebro = lote === 7 ? [intento(BOT_KEY, "10.255.0.1"), intento(BOT_KEY)] : [];
    const [estados, deCerebro] = await Promise.all([
      Promise.all(fallidos),
      Promise.all(cerebro),
    ]);
    for (const s of estados) vistos[s] = (vistos[s] ?? 0) + 1;
    cerebroDurante.push(...deCerebro);
  }
  ok(
    "la inundación: 30 → 401 y las otras 670 → 429 (frenada por IP)",
    vistos[401] === 30 && vistos[429] === 670,
    JSON.stringify(vistos)
  );
  ok(
    "el cerebro DURANTE la inundación → 200 (otra IP y la misma)",
    cerebroDurante.length === 2 && cerebroDurante.every((s) => s === 200),
    JSON.stringify(cerebroDurante)
  );
  const despues = [await intento(BOT_KEY, "10.255.0.1"), await intento(BOT_KEY)];
  ok(
    "el cerebro DESPUÉS de la inundación → 200",
    despues.every((s) => s === 200),
    JSON.stringify(despues)
  );
  const otraIp = await intento(undefined, `10.254.${Number(RUN.slice(2, 4))}.${Number(RUN.slice(4, 6))}`);
  ok("otra IP sin key sigue en 401 (el freno es por IP, no global)", otraIp === 401, `status=${otraIp}`);

  /*
   * 2. Quem escreveu primeiro COM telefone e depois chega só com BSUID: o
   *    contexto por `bsuid:<id>` é o seu contato. Antes: 404, e o cérebro
   *    não conseguia responder.
   */
  console.log("\n== R11: contexto por BSUID de quien escribió con teléfono ==");
  const inbound = (body) =>
    api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({ phoneNumberId: PN, ...body }),
    });
  const convDe = async (canonico) =>
    ((await api("/api/conversations")).json?.conversations ?? []).find(
      (c) => c.contact.phone === canonico
    );
  const mensajesDe = async (id) =>
    (await api(`/api/conversations/${id}/messages`)).json?.messages ?? [];
  const CANON = `524629${RUN}`;
  const BSU = `MX.r11.${RUN}`;
  const NOMBRE = `R11 BSUID ${RUN}`;
  await inbound({
    from: `5214629${RUN}`,
    fromUserId: BSU,
    name: NOMBRE,
    text: "hola, les escribo con mi número",
    waMessageId: `wamid.e2e.r11.tel.${RUN}`,
  });
  await hasta(async () => Boolean(await convDe(CANON)));
  const conv = await convDe(CANON);
  ok("el contacto nace con el teléfono como identidad", Boolean(conv));

  // A Meta não envia mais o telefone: só o BSUID.
  await inbound({
    fromUserId: BSU,
    name: NOMBRE,
    text: "y ahora sin número",
    waMessageId: `wamid.e2e.r11.bsu.${RUN}`,
  });
  const reconciliado = await hasta(async () =>
    conv ? (await mensajesDe(conv.id)).some((m) => m.text === "y ahora sin número") : false
  );
  ok("la ingesta reconcilia el mensaje solo-BSUID a la MISMA conversación", reconciliado);

  const bsuid = encodeURIComponent(`bsuid:${BSU}`);
  const porBsuid = await bot(`/api/bot/context?waIdentity=${bsuid}`);
  ok(
    "GET /api/bot/context?waIdentity=bsuid:<id> → 200 (antes 404)",
    porBsuid.res.status === 200,
    `status=${porBsuid.res.status}`
  );
  ok(
    "…y es el MISMO contacto y conversación (su identidad sigue siendo el teléfono)",
    porBsuid.json?.conversation?.id === conv?.id &&
      porBsuid.json?.contact?.waIdentity === CANON,
    JSON.stringify({ conv: porBsuid.json?.conversation?.id, contact: porBsuid.json?.contact })
  );
  const neutro = await bot(`/api/bot/context?identity=${bsuid}`);
  ok(
    "el nombre neutro `identity` resuelve igual",
    neutro.json?.conversation?.id === conv?.id,
    `status=${neutro.res.status}`
  );
  const nadie = await bot(
    `/api/bot/context?waIdentity=${encodeURIComponent(`bsuid:MX.r11.nadie.${RUN}`)}`
  );
  ok("un BSUID que nadie tiene sigue en 404", nadie.res.status === 404, `status=${nadie.res.status}`);

  /*
   * 3. Pedir horário com a agenda desligada não termina em "Erro do provedor
   *    de IA": o ai-mock não oferece mais horários que o prompt não lhe ensinou
   *    (o esquema do turno os rejeitava e o agente transferia).
   */
  const agenda = /^(on|1|true|si|sí|yes)$/i.test((process.env.AGENDA ?? "").trim());
  console.log(`\n== R11: pedir cita con la agenda ${agenda ? "encendida" : "apagada"} ==`);
  await api("/api/agent/profile", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const CANON_CITA = `524630${RUN}`;
  await inbound({
    from: `5214630${RUN}`,
    name: `R11 Cita ${RUN}`,
    text: "hola, ¿dan citas el sábado?",
    waMessageId: `wamid.e2e.r11.cita.${RUN}`,
  });
  const salientesCita = async () => {
    const c = await convDe(CANON_CITA);
    return c ? (await mensajesDe(c.id)).filter((m) => m.direction === "out") : [];
  };
  await hasta(
    async () =>
      Boolean((await convDe(CANON_CITA))?.handoffAt) || (await salientesCita()).length > 0,
    25000
  );
  const convCita = await convDe(CANON_CITA);
  const salientes = await salientesCita();
  ok(
    "el agente contesta y NO traspasa por «Error del proveedor de IA»",
    !convCita?.handoffAt && salientes.some((m) => m.origin === "ai"),
    JSON.stringify({ reason: convCita?.handoffReason, salientes: salientes.map((m) => m.text) })
  );
  if (!agenda) {
    ok(
      "con la agenda apagada no ofrece horarios",
      !salientes.some((m) => /horario/i.test(m.text ?? "")),
      JSON.stringify(salientes.map((m) => m.text))
    );
  }
  await api("/api/agent/profile", { method: "PUT", body: JSON.stringify({ enabled: false }) });
}
