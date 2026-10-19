import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { MetaApiError } from "@/lib/meta/client";
import { registerWebhookForNumber } from "@/server/whatsapp/connect";

/**
 * Salvar a conexão do WhatsApp registra o webhook no número, mas SEM
 * sobrescrever um override de callback da WABA: na Meta, `POST
 * {WABA}/subscribed_apps` sem corpo é exatamente como se remove o
 * callback alternativo, e o override do número tem prioridade sobre o da
 * WABA. Com qualquer uma dessas coisas, um cérebro externo (Nea) ou o backend
 * de uma agência deixava de receber mensagens sempre que alguém clicava em
 * "Guardar" ou girava o token.
 */

const { graphRequest } = vi.hoisted(() => ({ graphRequest: vi.fn() }));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});

const WABA = "WABA-1";
const PHONE = "PN-1";
const TOKEN = "EAAG-token-secreto-1234";
const APP = { id: "123", name: "Mi app", link: "https://www.facebook.com/games/?app_id=123" };
/** O webhook desta instância: o verify token é o segmento secreto. */
const URL_PROPIA = "https://crm.ejemplo.com/api/webhooks/wa/verify-secreto-xyz";
/** O override da Nea também leva seu próprio segmento secreto. */
const OVERRIDE = "https://nea.ejemplo.com/api/webhooks/wa/segmento-secreto-abc";

const opts = {
  wabaId: WABA,
  phoneNumberId: PHONE,
  token: TOKEN,
  webhookUrl: URL_PROPIA,
  verifyToken: "verify-secreto-xyz",
};

type Call = [path: string, opts: { method?: string; token: string; body?: unknown }];
const calls = () => graphRequest.mock.calls as Call[];
const posts = () => calls().filter(([, o]) => o.method === "POST");
const subscriptions = () =>
  posts().filter(([path]) => path === `${WABA}/subscribed_apps`);

/**
 * Uma «Meta» mínima: responde conforme a rota, e lembra o override do
 * número para que a confirmação o devolva tal como o puseram.
 */
function metaFalsa(subscribedApps: unknown, phoneOverride: string | null = null) {
  let override = phoneOverride;
  graphRequest.mockImplementation(async (path: string, o: Call[1]) => {
    const method = o.method ?? "GET";
    if (path === `${WABA}/subscribed_apps` && method === "GET") {
      if (subscribedApps instanceof Error) throw subscribedApps;
      return subscribedApps;
    }
    if (path === `${WABA}/subscribed_apps` && method === "POST") return { success: true };
    if (path === PHONE && method === "POST") {
      const config = (o.body as { webhook_configuration: { override_callback_uri: string } })
        .webhook_configuration;
      override = config.override_callback_uri || null;
      return { success: true };
    }
    if (path === `${PHONE}?fields=webhook_configuration`) {
      return {
        webhook_configuration: {
          ...(override ? { phone_number: override } : {}),
          application: "https://app.ejemplo.com/webhook",
        },
        id: PHONE,
      };
    }
    throw new Error(`ruta inesperada en la prueba: ${method} ${path}`);
  });
  return { get override() { return override; } };
}

let log: MockInstance<typeof console.log>;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  graphRequest.mockReset();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
});

/** Tudo o que foi escrito no console, para buscar segredos vazados. */
function consoleText(): string {
  return [...log.mock.calls, ...warn.mock.calls].flat().map(String).join("\n");
}

describe("registerWebhookForNumber — la WABA ya enruta a un override ajeno", () => {
  it("consulta subscribed_apps, NO re-suscribe y NO registra el número: lo respeta", async () => {
    const meta = metaFalsa({
      data: [{ whatsapp_business_api_data: APP, override_callback_uri: OVERRIDE }],
    });

    await expect(registerWebhookForNumber(opts)).resolves.toEqual({
      ok: true,
      skipped: "waba_override",
      host: "nea.ejemplo.com",
    });

    const [path, o] = calls()[0]!;
    expect(path).toBe(`${WABA}/subscribed_apps`);
    expect(o.method ?? "GET").toBe("GET");
    expect(o.token).toBe(TOKEN);
    expect(subscriptions()).toHaveLength(0);
    expect(meta.override).toBeNull();
  });

  it("si un guardado anterior dejó NUESTRO override en el número, lo quita: el del número ganaría", async () => {
    const meta = metaFalsa(
      { data: [{ whatsapp_business_api_data: APP, override_callback_uri: OVERRIDE }] },
      URL_PROPIA
    );

    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({ skipped: "waba_override" });

    expect(meta.override).toBeNull();
    const quitar = posts().find(([path]) => path === PHONE);
    expect(quitar?.[1].body).toEqual({ webhook_configuration: { override_callback_uri: "" } });
  });

  it("un override ajeno en el número no se toca", async () => {
    const meta = metaFalsa(
      { data: [{ whatsapp_business_api_data: APP, override_callback_uri: OVERRIDE }] },
      "https://otra-plataforma.test/webhook"
    );
    await registerWebhookForNumber(opts);
    expect(meta.override).toBe("https://otra-plataforma.test/webhook");
    expect(posts()).toHaveLength(0);
  });

  it("lo deja dicho en el log, sin el token ni las rutas secretas", async () => {
    metaFalsa({
      data: [{ whatsapp_business_api_data: APP, override_callback_uri: OVERRIDE }],
    });

    await registerWebhookForNumber(opts);

    const text = consoleText();
    expect(text).toMatch(/override/);
    expect(text).toContain(WABA);
    expect(text).toContain("nea.ejemplo.com");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("segmento-secreto-abc");
    expect(text).not.toContain("verify-secreto-xyz");
  });

  it("basta con que UNA de las apps suscritas tenga override", async () => {
    metaFalsa({
      data: [
        { whatsapp_business_api_data: { id: "999", name: "Otra app" } },
        { whatsapp_business_api_data: APP, override_callback_uri: OVERRIDE },
      ],
    });

    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({ skipped: "waba_override" });
    expect(subscriptions()).toHaveLength(0);
  });
});

describe("registerWebhookForNumber — la WABA ya enruta a ESTA instancia (override de agencia)", () => {
  it("no re-suscribe (lo borraría) y registra el número igual: mismo destino", async () => {
    const meta = metaFalsa({
      data: [
        {
          whatsapp_business_api_data: APP,
          // Outro domínio, mesma rota: a instância mudou de domínio.
          override_callback_uri: "https://viejo.ejemplo.com/api/webhooks/wa/verify-secreto-xyz",
        },
      ],
    });

    await expect(registerWebhookForNumber(opts)).resolves.toEqual({
      ok: true,
      appWithoutWebhook: false,
    });
    expect(subscriptions()).toHaveLength(0);
    expect(meta.override).toBe(URL_PROPIA);
  });
});

describe("registerWebhookForNumber — sin override (modo directo)", () => {
  it("app suscrita sin override → suscribe como siempre y registra el número", async () => {
    const meta = metaFalsa({ data: [{ whatsapp_business_api_data: APP }] });

    await expect(registerWebhookForNumber(opts)).resolves.toEqual({
      ok: true,
      appWithoutWebhook: false,
    });

    expect(subscriptions()).toEqual([[`${WABA}/subscribed_apps`, { method: "POST", token: TOKEN }]]);
    expect(meta.override).toBe(URL_PROPIA);
  });

  it("ninguna app suscrita todavía (data vacío) → suscribe", async () => {
    metaFalsa({ data: [] });
    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({ ok: true });
    expect(subscriptions()).toHaveLength(1);
  });

  it("un override vacío o en blanco no cuenta como override", async () => {
    metaFalsa({ data: [{ whatsapp_business_api_data: APP, override_callback_uri: "  " }] });
    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({ ok: true });
    expect(subscriptions()).toHaveLength(1);
  });

  it("una respuesta sin `data` (o vacía) se trata como sin override", async () => {
    metaFalsa({});
    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({ ok: true });
    expect(subscriptions()).toHaveLength(1);

    graphRequest.mockReset();
    metaFalsa(null);
    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({ ok: true });
    expect(subscriptions()).toHaveLength(1);
  });
});

describe("registerWebhookForNumber — la consulta falla", () => {
  it("se conserva el POST best-effort de siempre y se sigue con el número", async () => {
    const meta = metaFalsa(new MetaApiError("(#200) Permissions error", { status: 403, code: 200 }));

    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({ ok: true });
    expect(subscriptions()).toHaveLength(1);
    expect(meta.override).toBe(URL_PROPIA);
    expect(warn).toHaveBeenCalled();
    expect(consoleText()).not.toContain(TOKEN);
  });

  it("si también falla la suscripción, lo dice y NO lanza (guardar sigue)", async () => {
    graphRequest
      .mockRejectedValueOnce(new MetaApiError("No se pudo contactar la API de Meta", { status: 0 }))
      .mockRejectedValueOnce(new MetaApiError("No se pudo contactar la API de Meta", { status: 0 }));

    await expect(registerWebhookForNumber(opts)).resolves.toMatchObject({
      ok: false,
      code: "meta_unavailable",
    });
    expect(posts()).toHaveLength(1);
    expect(consoleText()).not.toContain(TOKEN);
  });
});
