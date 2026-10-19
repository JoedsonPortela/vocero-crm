import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_META, CONNECTOR_ORDER } from "@/lib/agenda-connectors";
import { enlaceFijoConnector } from "@/server/agenda/connectors/enlace-fijo";
import { zoomConnector, ZOOM_SCOPES } from "@/server/agenda/connectors/zoom";
import { googleConnector } from "@/server/agenda/connectors/google";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { clearZoomTokenCache } from "@/server/agenda/connectors/zoom-credentials";
import { clearGoogleTokenCache } from "@/server/agenda/connectors/google-credentials";

/**
 * 015 — A suíte de contrato de conectores.
 *
 * É a mesma para todos de propósito: acrescentar um conector num fork significa
 * passar ESTES testes, não inventar os seus. O que se fixa aqui são as
 * quatro operações e as duas regras que o motor dá por certas: apagar é
 * idempotente, e mover conserva o link.
 */

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    ZOOM_BASE_URL: "https://zoom.test/v2",
    ZOOM_OAUTH_BASE_URL: "https://oauth.zoom.test",
    GOOGLE_CAL_BASE_URL: "https://cal.google.test/v3",
    GOOGLE_OAUTH_BASE_URL: "https://oauth.google.test",
  }),
}));

const REQ = {
  topic: "Cita — Ana",
  startUtc: "2026-08-05T15:00:00.000Z",
  durationMinutes: 30,
  timezone: "America/Mexico_City",
};

describe("el catálogo", () => {
  it("todo conector declarado tiene su ficha para la pantalla", () => {
    for (const id of CONNECTOR_ORDER) {
      const meta = CONNECTOR_META[id];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it("existe al menos un conector SIN dependencias externas", () => {
    // É a condição constitucional: o caminho soberano tem que existir,
    // senão os conectores externos não seriam opcionais de verdade.
    expect(CONNECTOR_ORDER.some((id) => !CONNECTOR_META[id].external)).toBe(true);
  });

  it("el default no habla con nadie", () => {
    expect(CONNECTOR_META["enlace-fijo"].external).toBe(false);
    expect(enlaceFijoConnector.requiresCredentials).toBe(false);
  });
});

describe("enlace-fijo", () => {
  it("entrega la sala configurada, sin id externo", async () => {
    const out = await enlaceFijoConnector.createMeeting(
      { meetingLink: "https://meet.ejemplo.com/sala" },
      REQ
    );
    expect(out).toEqual({
      externalId: null,
      joinUrl: "https://meet.ejemplo.com/sala",
    });
  });

  it("sin sala configurada entrega null en vez de fallar", async () => {
    // O agendamento é criado do mesmo jeito: ninguém promete um link que não existe.
    const out = await enlaceFijoConnector.createMeeting({ meetingLink: null }, REQ);
    expect(out.joinUrl).toBeNull();
  });

  it("mover y borrar no hacen nada, y no lanzan", async () => {
    await expect(
      enlaceFijoConnector.updateMeeting({ meetingLink: null }, "x", REQ)
    ).resolves.toBeUndefined();
    await expect(
      enlaceFijoConnector.deleteMeeting({ meetingLink: null }, "x")
    ).resolves.toBeUndefined();
  });

  it("siempre está conectado: no hay nada que conectar", async () => {
    await expect(
      enlaceFijoConnector.testConnection({ meetingLink: null })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("zoom", () => {
  const creds = {
    accountId: "acc_1",
    clientId: "cli_1",
    clientSecret: "sec_1",
    status: "connected" as const,
  };
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearZoomTokenCache();
    calls.length = 0;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/oauth/token")) {
        return Response.json({ access_token: "tk", expires_in: 3600 });
      }
      if (url.endsWith("/users/me/meetings")) {
        return Response.json({ id: 91234, join_url: "https://zoom.test/j/91234" });
      }
      if (url.endsWith("/users/me")) {
        return Response.json({ email: "dueño@negocio.test" });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("la guía de scopes incluye el de leer usuario, que usa la prueba de conexión", () => {
    // O tropeço real: documentar só os de reunião faz com que conectar falhe
    // com credenciais que na verdade servem.
    expect(ZOOM_SCOPES).toContain("user:read:user");
    expect(ZOOM_SCOPES).toContain("meeting:write:meeting");
  });

  it("crear manda la reunión programada y devuelve id + enlace", async () => {
    const out = await zoomConnector.createMeeting(creds, REQ);
    expect(out).toEqual({
      externalId: "91234",
      joinUrl: "https://zoom.test/j/91234",
    });

    const create = calls.find((c) => c.url.endsWith("/users/me/meetings"));
    const body = create?.body as Record<string, unknown>;
    expect(body.type).toBe(2);
    expect(body.topic).toBe("Cita — Ana");
    expect(body.timezone).toBe("America/Mexico_City");
    // O Zoom recusa os milissegundos.
    expect(body.start_time).toBe("2026-08-05T15:00:00Z");
  });

  it("el token se pide una vez y se reutiliza", async () => {
    await zoomConnector.createMeeting(creds, REQ);
    await zoomConnector.createMeeting(creds, REQ);
    const tokenCalls = calls.filter((c) => c.url.includes("/oauth/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("mover usa el MISMO id y solo manda la hora: el enlace no cambia", async () => {
    await zoomConnector.updateMeeting(creds, "91234", {
      startUtc: "2026-08-06T16:00:00.000Z",
      durationMinutes: 45,
      timezone: "America/Mexico_City",
    });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/meetings/91234");
    const body = patch?.body as Record<string, unknown>;
    expect(body.start_time).toBe("2026-08-06T16:00:00Z");
    expect(body.duration).toBe(45);
    // Não reenvia o tema nem os ajustes: só se moveu o horário.
    expect(body.topic).toBeUndefined();
  });

  it("borrar algo que ya no está es ÉXITO, no error (idempotencia)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return Response.json({ access_token: "tk", expires_in: 3600 });
      }
      return new Response(null, { status: 404 });
    });
    await expect(
      zoomConnector.deleteMeeting(creds, "ya-borrada")
    ).resolves.toBeUndefined();
  });

  it("probar la conexión pega a users/me", async () => {
    const out = await zoomConnector.testConnection(creds);
    expect(out).toMatchObject({ ok: true, detail: "dueño@negocio.test" });
  });

  it("credenciales rechazadas → error de AUTENTICACIÓN, para marcar la conexión rota", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ error: "invalid_client" }, { status: 400 })
    );
    await expect(zoomConnector.createMeeting(creds, REQ)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConnectorError && err.isAuthError && err.connectorId === "zoom"
    );
  });

  it("un 400 de la API (no del token) NO se confunde con credenciales rotas", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return Response.json({ access_token: "tk", expires_in: 3600 });
      }
      return Response.json({ message: "start_time inválido" }, { status: 400 });
    });
    await expect(zoomConnector.createMeeting(creds, REQ)).rejects.toSatisfy(
      (err: unknown) => err instanceof ConnectorError && !err.isAuthError
    );
  });

  it("probar la conexión nunca lanza: devuelve el fallo como dato", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("sin red");
    });
    const out = await zoomConnector.testConnection(creds);
    expect(out.ok).toBe(false);
  });
});

describe("google", () => {
  const creds = {
    clientId: "cli_1",
    clientSecret: "sec_1",
    refreshToken: "ref_1",
    calendarId: "primary",
    status: "connected" as const,
  };
  const calls: { url: string; method: string }[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Leituras do evento antes de a conferência estar pronta. */
  let pendingReads = 0;

  beforeEach(() => {
    clearGoogleTokenCache();
    calls.length = 0;
    pendingReads = 0;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });

      if (url.endsWith("/token")) {
        return Response.json({ access_token: "tk", expires_in: 3600 });
      }
      if (method === "POST") {
        // Como o Google de verdade: o evento nasce SEM link do Meet.
        return Response.json({
          id: "evt_1",
          conferenceData: { createRequest: { status: { statusCode: "pending" } } },
        });
      }
      if (method === "GET") {
        if (pendingReads > 0) {
          pendingReads -= 1;
          return Response.json({
            id: "evt_1",
            conferenceData: {
              createRequest: { status: { statusCode: "pending" } },
            },
          });
        }
        return Response.json({
          id: "evt_1",
          summary: "Calendario de prueba",
          conferenceData: {
            entryPoints: [
              { entryPointType: "video", uri: "https://meet.google.test/abc" },
            ],
          },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("crear re-lee el evento hasta que aparece el enlace de Meet", async () => {
    // A conferência é ASSÍNCRONA: ficar com a resposta do insert
    // deixaria todos os agendamentos sem link.
    pendingReads = 1;
    const out = await googleConnector.createMeeting(creds, REQ);
    expect(out.externalId).toBe("evt_1");
    expect(out.joinUrl).toBe("https://meet.google.test/abc");
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(1);
  });

  it("si la conferencia sigue pendiente, devuelve el evento SIN enlace en vez de fallar", async () => {
    // O motor traduz isso como "agendamento sem link, pode repetir": o agendamento não se
    // perde por um atraso do provedor.
    pendingReads = 99;
    const out = await googleConnector.createMeeting(creds, REQ);
    expect(out.externalId).toBe("evt_1");
    expect(out.joinUrl).toBeNull();
  });

  it("refrescar lee el MISMO evento: reintentar no duplica la cita en el calendario", async () => {
    const out = await googleConnector.refreshMeeting!(creds, "evt_1");
    expect(out.externalId).toBe("evt_1");
    expect(out.joinUrl).toBe("https://meet.google.test/abc");
    // Nem um só POST a events: o do token não conta.
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("/events"))
    ).toBe(false);
  });

  it("borrar tolera el 404 (idempotencia)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/token")) {
        return Response.json({ access_token: "tk", expires_in: 3600 });
      }
      return new Response(null, { status: 404 });
    });
    await expect(
      googleConnector.deleteMeeting(creds, "evt_borrado")
    ).resolves.toBeUndefined();
  });

  it("un refresh token revocado es error de AUTENTICACIÓN y lo explica", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    );
    await expect(googleConnector.createMeeting(creds, REQ)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConnectorError &&
        err.isAuthError &&
        // A mensagem nomeia a causa mais comum: o app OAuth em modo de teste.
        /modo prueba/.test(err.message)
    );
  });
});
