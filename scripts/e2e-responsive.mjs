/**
 * Self-test E2E de comportamento — responsividade (celular / tablet / desktop).
 * Roteiro: tests/e2e/responsividad.md
 *
 * Verifica que o CRM pode ser USADO pelo celular, não só que "caiba":
 *  - a lateral vira gaveta com hambúrguer e fecha ao navegar;
 *  - a Bandeja se comporta como mestre-detalhe (lista ↔ conversa com "voltar");
 *  - o painel de detalhes flutua sobre a conversa em vez de roubar largura;
 *  - nenhuma tela corta conteúdo na largura (main não estoura);
 *  - os campos de texto medem ≥16px (senão o iOS dá zoom e desalinha tudo);
 *  - no desktop NADA do que foi dito muda (a lateral continua fixa);
 *  - a barra lateral é azul-marinho também com o tema claro, e a bolinha dos
 *    interruptores fica dentro da sua trilha, ligada e desligada (#53);
 *  - com o tema escuro a barra continua mais escura que a página, o que flutua
 *    se destaca e a faixa do celular é a mesma peça que a barra (R8).
 *
 * Uso: node scripts/e2e-responsive.mjs
 * Requer: app rodando (pnpm dev) com WA_MOCK_ENABLED=true e Playwright.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-RESP-1";
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
const SHOTS = "scratch/responsive";
let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* tenta de novo */
    }
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
};

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };
const RUTAS = [
  "/inbox",
  "/pipeline",
  "/contacts",
  "/results",
  "/agent",
  "/lab",
  "/settings/whatsapp",
];

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: DESKTOP });
const req = ctx.request;
// O canal SSE é cortado no navegador: não traz nada para o design e cada
// stream ativo ocupa um slot do servidor do `next dev` — na ~15ª carga o
// servidor para de responder (trava o roteiro, não o produto).
await ctx.route("**/api/events*", (route) => route.abort());

console.log("== Setup ==");
let r = await req.post(`${BASE}/api/auth/sign-up/email`, {
  headers: { origin: BASE },
  data: {
    email: "e2e@vocero.test",
    password: "password-e2e-123",
    name: "Operador E2E",
  },
});
if (!r.ok())
  r = await req.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { origin: BASE },
    data: { email: "e2e@vocero.test", password: "password-e2e-123" },
  });
ok("login", r.ok());
await req.put(`${BASE}/api/settings/whatsapp`, {
  data: { wabaId: "WABA-RESP", phoneNumberId: PN, token: "tok-resp" },
});

const NAME = `Prospecto${S}`;
await req.post(`${BASE}/api/dev/wa-mock/inbound`, {
  data: {
    phoneNumberId: PN,
    from: `521462${Math.floor(Math.random() * 9e6) + 1e6}`,
    name: NAME,
    text: "hola, vi su anuncio y quiero saber cuánto cuesta el diagnóstico",
    waMessageId: `wamid.resp.${S}`,
  },
});
const listo = await until(async () => {
  const d = await (await req.get(`${BASE}/api/conversations`)).json();
  return d.conversations.some((c) => c.contact.name === NAME);
});
ok("conversación de prueba creada", listo);

// Aquece cada rota: no `pnpm dev` a primeira visita compila (3-4 s) e o
// roteiro mediria a compilação, não o design.
// A primeira visita a cada rota a COMPILA (`next dev`), e algumas passam dos
// 30 s padrão do Playwright. Aquecem-se por HTTP, sem navegador: um
// `page.goto` abriria também o canal SSE do app, e várias páginas com SSE
// ativo ao mesmo tempo travam o servidor de desenvolvimento.
ctx.setDefaultNavigationTimeout(120000);
ctx.setDefaultTimeout(30000);
for (const ruta of RUTAS) {
  await req.get(`${BASE}${ruta}`, { timeout: 180000 });
}

/** Largura real do conteúdo contra a largura visível do contêiner. */
const desborde = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    const doc = document.documentElement;
    return {
      mainOver: main ? main.scrollWidth - main.clientWidth : 0,
      docOver: doc.scrollWidth - window.innerWidth,
    };
  });

async function recorrer(page, etiqueta) {
  for (const ruta of RUTAS) {
    await page.goto(`${BASE}${ruta}`, { waitUntil: "domcontentloaded" });
    // Nada de `networkidle`: o canal SSE fica aberto de propósito e a
    // espera nunca se cumpriria.
    await sleep(900);
    const d = await desborde(page);
    ok(
      `${etiqueta} ${ruta} sin recorte horizontal`,
      d.mainOver <= 1 && d.docOver <= 1,
      `main +${d.mainOver}px · documento +${d.docOver}px`
    );
    await page.screenshot({
      path: `${SHOTS}/${etiqueta}${ruta.replace(/\//g, "-")}.png`,
      fullPage: false,
    });
  }
}

console.log("\n== 1. Teléfono (390×844): ninguna pantalla se recorta ==");
const phone = await ctx.newPage();
await phone.setViewportSize(PHONE);
await recorrer(phone, "phone");

console.log("\n== 2. Teléfono: el lateral es un cajón con hamburguesa ==");
await phone.goto(`${BASE}/pipeline`);
const hamburguesa = phone.getByRole("button", { name: "Abrir el menú" });
await hamburguesa.waitFor({ timeout: 20000 });
ok("la hamburguesa se ve", await hamburguesa.isVisible());
const linkBandeja = phone.getByRole("link", { name: /Bandeja/ });
ok(
  "el lateral arranca oculto (sus enlaces no son alcanzables)",
  !(await linkBandeja.isVisible())
);
await hamburguesa.click();
ok(
  "al tocar la hamburguesa el cajón abre",
  await until(async () => await linkBandeja.isVisible(), 3000)
);
// A gaveta NÃO deve empurrar o conteúdo: sai por cima.
const encima = await phone.evaluate(() => {
  const aside = document.querySelector("aside");
  const main = document.querySelector("main");
  if (!aside || !main) return null;
  const a = aside.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  return { asideLeft: Math.round(a.left), mainLeft: Math.round(m.left) };
});
ok(
  "el cajón flota encima del contenido (no lo empuja)",
  encima !== null && encima.asideLeft <= 1 && encima.mainLeft <= 1,
  JSON.stringify(encima)
);
await phone.screenshot({ path: `${SHOTS}/phone-cajon-abierto.png` });
await linkBandeja.click();
await until(async () => phone.url().includes("/inbox"), 15000);
ok("navegar desde el cajón lleva a la Bandeja", phone.url().includes("/inbox"));
ok(
  "el cajón se cierra solo al navegar",
  await until(async () => !(await linkBandeja.isVisible()), 5000)
);

console.log("\n== 3. Teléfono: la Bandeja es maestro-detalle ==");
await phone.goto(`${BASE}/inbox`);
const fila = phone.getByText(NAME).first();
await fila.waitFor({ timeout: 20000 });
ok("la lista de conversaciones ocupa la pantalla", await fila.isVisible());
const anchoLista = await phone.evaluate(() => {
  const sec = document.querySelector("main > div > section");
  return sec ? Math.round(sec.getBoundingClientRect().width) : 0;
});
ok(
  "la lista usa el ancho completo del teléfono",
  anchoLista >= PHONE.width - 8,
  `${anchoLista}px de ${PHONE.width}`
);
await fila.click();
const composer = phone.getByPlaceholder("Escribe una respuesta");
ok(
  "al elegir una conversación se abre el hilo",
  await until(async () => await composer.isVisible(), 15000)
);
ok("la lista cede la pantalla al hilo", !(await fila.isVisible()));
const volver = phone.getByRole("button", { name: "Volver a las conversaciones" });
ok("aparece el botón de volver", await volver.isVisible());
await phone.screenshot({ path: `${SHOTS}/phone-hilo.png` });

// O compositor deve ficar DENTRO da tela (100dvh, não 100vh).
const compBox = await composer.boundingBox();
ok(
  "el compositor queda dentro de la pantalla",
  compBox !== null && compBox.y + compBox.height <= PHONE.height,
  compBox ? `borde inferior en ${Math.round(compBox.y + compBox.height)}px` : "sin caja"
);
// iOS: menos de 16px = zoom automático ao focar.
const fuenteComp = await composer.evaluate((el) =>
  parseFloat(getComputedStyle(el).fontSize)
);
ok(
  "el compositor usa ≥16px (iOS no hace zoom al enfocar)",
  fuenteComp >= 16,
  `${fuenteComp}px`
);

console.log("\n== 4. Teléfono: los detalles flotan sobre el hilo ==");
const abrirDetalles = phone.getByRole("button", { name: "Mostrar detalles" });
ok("el panel de detalles arranca cerrado en el teléfono", await abrirDetalles.isVisible());
await abrirDetalles.click();
await sleep(500);
const cajonDetalles = await phone.evaluate(() => {
  const secs = [...document.querySelectorAll("main > div > section")];
  const panel = secs[secs.length - 1];
  if (!panel) return null;
  const r = panel.getBoundingClientRect();
  return {
    right: Math.round(r.right),
    width: Math.round(r.width),
    fixed: getComputedStyle(panel).position === "fixed",
  };
});
ok(
  "los detalles entran como cajón pegado al borde derecho",
  cajonDetalles !== null &&
    cajonDetalles.fixed &&
    Math.abs(cajonDetalles.right - PHONE.width) <= 2 &&
    cajonDetalles.width <= PHONE.width,
  JSON.stringify(cajonDetalles)
);
const dEnDetalles = await desborde(phone);
ok(
  "con los detalles abiertos la pantalla sigue sin recortarse",
  dEnDetalles.docOver <= 1,
  `documento +${dEnDetalles.docOver}px`
);
await phone.screenshot({ path: `${SHOTS}/phone-detalles.png` });
await phone
  .getByRole("button", { name: "Cerrar los detalles" })
  .click()
  .catch(() => null);
await sleep(400);

console.log("\n== 5. Tableta (820×1180) ==");
const tablet = phone;
await tablet.setViewportSize(TABLET);
await recorrer(tablet, "tablet");
await tablet.goto(`${BASE}/inbox`);
await tablet.getByText(NAME).first().click();
await tablet.getByPlaceholder("Escribe una respuesta").waitFor({ timeout: 20000 });
const dosColumnas = await tablet.evaluate(() => {
  const secs = [...document.querySelectorAll("main > div > section")];
  return secs.slice(0, 2).map((s) => Math.round(s.getBoundingClientRect().width));
});
ok(
  "en tableta conviven lista e hilo (dos columnas)",
  dosColumnas.length === 2 && dosColumnas[0] > 200 && dosColumnas[1] > 300,
  JSON.stringify(dosColumnas)
);
await tablet.screenshot({ path: `${SHOTS}/tablet-inbox.png` });

console.log("\n== 6. Escritorio (1440×900): nada cambió ==");
const desk = tablet;
await desk.setViewportSize(DESKTOP);
await recorrer(desk, "desktop");
await desk.goto(`${BASE}/inbox`);
await desk.getByText(NAME).first().click();
await desk.getByPlaceholder("Escribe una respuesta").waitFor({ timeout: 20000 });
ok(
  "el lateral sigue fijo (sin hamburguesa)",
  !(await desk.getByRole("button", { name: "Abrir el menú" }).isVisible()) &&
    (await desk.getByRole("link", { name: /Bandeja/ }).isVisible())
);
const medirColumnas = () =>
  desk.evaluate(() => {
    const aside = document.querySelector("aside");
    const secs = [...document.querySelectorAll("main > div > section")];
    return {
      aside: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      secs: secs.map((s) => Math.round(s.getBoundingClientRect().width)),
    };
  });
// O painel abre com transição de 220 ms: medir assim que aparece o compositor
// pegaria uma largura no meio do caminho.
const columnasOk = (t) =>
  t.aside === 224 && t.secs[0] === 360 && t.secs.at(-1) === 320;
await until(async () => columnasOk(await medirColumnas()), 8000);
const tres = await medirColumnas();
ok(
  "escritorio conserva lateral 224px + lista 360px + hilo + detalles 320px",
  columnasOk(tres),
  JSON.stringify(tres)
);
await desk.screenshot({ path: `${SHOTS}/desktop-inbox.png` });

console.log("\n== 7. Barra bicolor e interruptores (#53) ==");
// Luminância relativa (WCAG) de um `rgb(...)` calculado: afirma-se que a
// barra é ESCURA e a página CLARA, não um hex concreto que um ajuste de
// tokens mudaria.
const luminancia = (rgb) => {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// O contexto não envia o cookie de tema: a página está em claro.
const barra = await desk.evaluate(() => {
  const aside = document.querySelector("aside");
  return {
    tema: document.documentElement.dataset.theme,
    fondo: aside ? getComputedStyle(aside).backgroundColor : "",
    tinta: aside ? getComputedStyle(aside).color : "",
    pagina: getComputedStyle(document.body).backgroundColor,
  };
});
ok(
  "con el tema claro, la barra lateral es azul marino y su texto claro",
  barra.tema === "light" &&
    luminancia(barra.fondo) < 0.05 &&
    luminancia(barra.tinta) > 0.6 &&
    luminancia(barra.pagina) > 0.8,
  JSON.stringify(barra)
);

/** Onde fica a bolinha em relação à sua trilha (px). */
const medirInterruptor = (page, nombre) =>
  page.evaluate((label) => {
    const pista = document.querySelector(`[role="switch"][aria-label="${label}"]`);
    const pomo = pista?.querySelector("span");
    if (!pista || !pomo) return null;
    const p = pista.getBoundingClientRect();
    const k = pomo.getBoundingClientRect();
    const r = (n) => Math.round(n * 10) / 10;
    return {
      on: pista.getAttribute("aria-checked") === "true",
      izq: r(k.left - p.left),
      der: r(p.right - k.right),
      arriba: r(k.top - p.top),
      abajo: r(p.bottom - k.bottom),
    };
  }, nombre);
// Dentro da trilha pelos quatro lados, e colada na extremidade do seu estado.
// A bolinha que saía do centro (#53) tinha `esq` ≈ 12 desligado e `dir` < 0
// ligado.
const pomoEnSuSitio = (m) =>
  m !== null &&
  m.izq >= 0 && m.der >= 0 && m.arriba >= 0 && m.abajo >= 0 &&
  (m.on ? m.der <= 3 : m.izq <= 3);

async function probarInterruptor(page, nombre) {
  const sw = page.locator(`[role="switch"][aria-label="${nombre}"]`);
  await sw.waitFor({ timeout: 20000 });
  const revisar = async (cuando) => {
    // A transição dura 150 ms: aguarda-se a bolinha chegar.
    const bien = await until(async () => pomoEnSuSitio(await medirInterruptor(page, nombre)), 3000);
    const m = await medirInterruptor(page, nombre);
    ok(
      `«${nombre}» ${m?.on ? "encendido" : "apagado"} (${cuando}): el pomo queda dentro, en su extremo`,
      bien,
      JSON.stringify(m)
    );
    return m?.on;
  };
  const inicial = await revisar("al cargar");
  if (await sw.isDisabled()) {
    // O do Agente sem OPENROUTER_API_TOKEN: esmaecido e sem reagir, de
    // propósito. Mede-se, mas não há nada para alternar.
    console.log(`  · «${nombre}» deshabilitado (sin proveedor de IA): solo se mide`);
    return;
  }
  await sw.click();
  ok(
    `«${nombre}»: un clic lo cambia`,
    await until(async () => (await medirInterruptor(page, nombre))?.on === !inicial, 15000)
  );
  await revisar("tras el clic");
  // De volta como estava, e com o teclado: é um <button>, Espaço o aciona.
  await sw.focus();
  await page.keyboard.press("Space");
  ok(
    `«${nombre}»: con el teclado vuelve a como estaba`,
    await until(async () => (await medirInterruptor(page, nombre))?.on === inicial, 15000)
  );
}

// Estado conhecido para a conversa: IA ativa e sem repasse pendente.
const convResp = (await (await req.get(`${BASE}/api/conversations`)).json())
  .conversations.find((c) => c.contact.name === NAME);
await req.patch(`${BASE}/api/conversations/${convResp?.id}`, {
  data: { reactivate: true, aiEnabled: true },
});
await desk.goto(`${BASE}/inbox`);
await desk.getByText(NAME).first().click();
await probarInterruptor(desk, "IA en esta conversación");

await desk.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
await probarInterruptor(desk, "Agente encendido");
await desk.screenshot({ path: `${SHOTS}/desktop-agente.png` });

console.log("\n== 8. Tema oscuro: el bicolor no desaparece (R8) ==");
// Mesmo critério da barra no claro: luminâncias medidas no navegador,
// não um hex. Com o tema escuro de antes, barra e página ficavam a 1.04:1.
const contraste = (a, b) => {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
await ctx.addCookies([{ name: "vocero-theme", value: "dark", url: BASE }]);
await desk.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" });
const nuevo = desk.getByRole("button", { name: /Nuevo contacto/ });
const dialogo = desk.locator('[role="dialog"][aria-label="Nuevo contacto"]');
// Um clique antes de hidratar se perde: tenta de novo até aparecer.
await until(async () => {
  await nuevo.click();
  return dialogo.isVisible();
}, 20000);
const oscuro = await desk.evaluate(() => {
  const aside = document.querySelector("aside");
  const dlg = document.querySelector('[role="dialog"][aria-label="Nuevo contacto"]');
  return {
    tema: document.documentElement.dataset.theme,
    barra: aside ? getComputedStyle(aside).backgroundColor : "",
    pagina: getComputedStyle(document.body).backgroundColor,
    dialogo: dlg ? getComputedStyle(dlg).backgroundColor : "",
  };
});
ok(
  "en oscuro, la barra es más oscura que la página (≥ 1.25:1)",
  oscuro.tema === "dark" &&
    luminancia(oscuro.barra) < luminancia(oscuro.pagina) &&
    contraste(oscuro.barra, oscuro.pagina) >= 1.25,
  JSON.stringify(oscuro)
);
ok(
  "en oscuro, el diálogo flota un escalón arriba de la página",
  luminancia(oscuro.dialogo) > luminancia(oscuro.pagina),
  JSON.stringify(oscuro)
);
await desk.keyboard.press("Escape");
await desk.setViewportSize(PHONE);
await desk.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
await desk.getByRole("button", { name: "Abrir el menú" }).waitFor({ timeout: 20000 });
const franja = await desk.evaluate(() => {
  const aside = document.querySelector("aside");
  const barra = document.querySelector("main")?.previousElementSibling;
  return {
    barra: barra ? getComputedStyle(barra).backgroundColor : "",
    lateral: aside ? getComputedStyle(aside).backgroundColor : "",
  };
});
ok(
  "en el teléfono, la franja de arriba es la misma pieza que la barra",
  franja.barra !== "" && franja.barra === franja.lateral,
  JSON.stringify(franja)
);
await desk.screenshot({ path: `${SHOTS}/phone-inbox-oscuro.png` });

console.log(
  failures === 0
    ? `\n✅ Responsividad: todo verde. Capturas en ${SHOTS}/`
    : `\n❌ Responsividad: ${failures} fallo(s). Capturas en ${SHOTS}/`
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
