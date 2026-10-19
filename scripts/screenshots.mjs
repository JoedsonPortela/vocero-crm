/**
 * Regenera as capturas do README (docs/screenshots/*.png) com a interface
 * atual, para que a capa não envelheça em relação ao produto.
 *
 * Roda contra um app LOCAL com os mocks ligados (WA_MOCK_ENABLED=true e
 * META_GRAPH_BASE_URL apontando para o wa-mock, ver o quickstart) e um banco
 * recém-migrado ou com a demo já carregada:
 *
 *   node --env-file=.env scripts/screenshots.mjs
 *
 * Requer o Playwright (devDependency) com seu Chromium instalado:
 *
 *   pnpm exec playwright install chromium
 *
 * O que faz: entra (ou cria o proprietário se o banco estiver vazio), carrega o
 * negócio demo, conecta um número de teste pelo mock e deixa a marca padrão;
 * depois captura as cinco telas da capa em 1440×900 no tema claro. Não toca
 * em nenhuma API real: tudo sai do mock.
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";
const VIEWPORT = { width: 1440, height: 900 };
const EMAIL = process.env.SCREENSHOTS_EMAIL ?? "capturas@vocero.test";
const PASSWORD = process.env.SCREENSHOTS_PASSWORD ?? "capturas-vocero-123";

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  locale: "es-MX",
  timezoneId: "America/Mexico_City",
  colorScheme: "light",
  reducedMotion: "reduce",
});

// A Bandeja abre o painel de detalhes conforme esta preferência de desktop.
await context.addInitScript(() => {
  try {
    localStorage.setItem("vocero.panelOpen", "true");
  } catch {
    // sem armazenamento não há preferência a lembrar
  }
});

// --- Sessão. A API e o navegador compartilham os cookies do contexto, então
// entrar pela API deixa o navegador já autenticado.
const api = context.request;
const call = (path, init = {}) =>
  api.fetch(`${BASE}${path}`, {
    ...init,
    // O Better Auth valida Origin (CSRF) nos endpoints de auth.
    headers: { origin: BASE, ...(init.headers ?? {}) },
  });

let session = await call("/api/auth/sign-up/email", {
  method: "POST",
  data: { email: EMAIL, password: PASSWORD, name: "Kevin" },
});
if (!session.ok()) {
  session = await call("/api/auth/sign-in/email", {
    method: "POST",
    data: { email: EMAIL, password: PASSWORD },
  });
}
if (!session.ok()) {
  console.error("No se pudo entrar:", session.status(), await session.text());
  process.exit(1);
}

// Demo (409 se já houver dados: não acontece nada), número de teste pelo mock e a
// marca exatamente como sai da caixa.
await call("/api/seed/demo", { method: "POST" });
await call("/api/settings/whatsapp", {
  method: "PUT",
  data: { wabaId: "waba-demo", phoneNumberId: "pn-demo-001", token: "token-demo" },
});
await call("/api/settings/branding", {
  method: "PUT",
  data: { name: "Vocero", accent: "#0d5bff", currency: "MXN" },
});

const page = await context.newPage();

/**
 * Navega, espera o que identifica a tela e captura. `load` e não
 * `networkidle`: a Bandeja mantém aberta a conexão SSE de /api/events e
 * a rede nunca fica ociosa.
 */
async function shoot(path, file, ready) {
  await page.goto(`${BASE}${path}`, { waitUntil: "load" });
  // O indicador de desenvolvimento do Next não faz parte do produto.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await ready();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${file}`, animations: "disabled" });
  console.log("  ✓", file);
}

await shoot("/inbox", "bandeja.png", async () => {
  await page.getByRole("button", { name: /María Fernanda/ }).first().click();
  await page.getByText("¿Tienen taladros inalámbricos?").waitFor();
  await page.getByText("Etapa del pipeline").waitFor();
});

await shoot("/pipeline", "pipeline.png", async () => {
  await page.getByText("Interesado").first().waitFor();
  await page.getByText("María Fernanda López").first().waitFor();
});

await shoot("/lab", "laboratorio.png", async () => {
  await page.getByText(/Score 83/).first().waitFor();
  // O relatório da execução chega numa segunda requisição: espera-se que o
  // vazio "escolha uma execução" desapareça, não um tempo fixo.
  await page
    .getByText("Elige una corrida del historial")
    .waitFor({ state: "hidden", timeout: 20_000 });
});

await shoot("/settings/branding", "marca.png", async () => {
  await page.getByText("Marca del CRM").waitFor();
  await page.getByText("Logo del negocio").waitFor();
});

await shoot("/settings/whatsapp", "wizard-whatsapp.png", async () => {
  await page.getByText(/Número conectado/).waitFor();
});

await browser.close();
console.log(`Listo: ${OUT}/*.png a ${VIEWPORT.width}×${VIEWPORT.height}`);
