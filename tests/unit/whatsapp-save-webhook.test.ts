import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As rotas da conexão (issue #84), com tudo o que está abaixo falso:
 *
 *   - `PUT /api/settings/whatsapp` salva e registra a URL FIXA desta
 *     instância no número; se a Meta disser que não, a conexão fica salva
 *     e a resposta conta isso em `webhook`.
 *   - `DELETE /api/settings/whatsapp` remove o override ANTES de apagar o
 *     token (sem ele não seria possível) e não toca em mais nada.
 *   - `POST /api/settings/webhook` tenta de novo com a conexão salva: 409 sem
 *     conexão, 422/503 com o motivo da Meta, 200 com o resultado.
 */

const env = vi.hoisted(() => ({
  APP_BASE_URL: "https://crm.ejemplo.test",
  META_WEBHOOK_VERIFY_TOKEN: "verify-abc",
  META_APP_SECRET: undefined as string | undefined,
}));
const register = vi.hoisted(() => vi.fn());
const unregister = vi.hoisted(() => vi.fn(async () => {}));
const save = vi.hoisted(() => vi.fn(async () => {}));
const disconnect = vi.hoisted(() => vi.fn(async () => {}));
const creds = vi.hoisted(() => ({
  current: null as null | {
    wabaId: string;
    phoneNumberId: string;
    token: string;
    status: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
  },
}));

vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ userId: "usr_1", organizationId: "org_a", role: "owner" }),
  getSessionOrNull: async () => ({ userId: "usr_1", organizationId: "org_a", role: "owner" }),
}));
vi.mock("@/server/channels/enabled", () => ({ isChannelEnabled: () => false }));
vi.mock("@/server/whatsapp/credentials", () => ({
  desconectarCanal: disconnect,
  getCredentialsByOrg: async () => creds.current,
  saveCredentials: save,
  tokenLast4: (t: string) => t.slice(-4),
}));
vi.mock("@/server/whatsapp/connect", () => ({
  testConnection: async () => ({
    ok: true,
    displayPhoneNumber: "+52 55 0000 0000",
    verifiedName: "Negocio",
  }),
  registerWebhookForNumber: register,
  unregisterWebhookForNumber: unregister,
}));

import { DELETE, PUT } from "@/app/api/settings/whatsapp/route";
import { GET as webhookGet, POST as webhookPost } from "@/app/api/settings/webhook/route";

const URL_FIJA = "https://crm.ejemplo.test/api/webhooks/wa/verify-abc";

const put = () =>
  PUT(
    new Request("https://crm.ejemplo.test/api/settings/whatsapp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wabaId: "111", phoneNumberId: "222", token: "EAAG-token" }),
    })
  );

beforeEach(() => {
  register.mockReset();
  unregister.mockClear();
  save.mockClear();
  disconnect.mockClear();
  creds.current = null;
});

describe("guardar la conexión registra el webhook", () => {
  it("registra la URL fija de esta instancia en el número y lo devuelve", async () => {
    register.mockResolvedValueOnce({ ok: true, appWithoutWebhook: false });
    const res = await put();
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({
      wabaId: "111",
      phoneNumberId: "222",
      token: "EAAG-token",
      webhookUrl: URL_FIJA,
      verifyToken: "verify-abc",
    });
    expect(await res.json()).toEqual({
      ok: true,
      displayPhoneNumber: "+52 55 0000 0000",
      webhook: { ok: true, appWithoutWebhook: false },
    });
  });

  it("si Meta rechaza el webhook, la conexión queda guardada y se avisa (200)", async () => {
    register.mockResolvedValueOnce({
      ok: false,
      code: "missing_permission",
      message: "sin permiso",
    });
    const res = await put();
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect((await res.json()).webhook).toMatchObject({ ok: false, code: "missing_permission" });
  });

  it("registra DESPUÉS de guardar: el número ya enruta por la conexión guardada", async () => {
    register.mockImplementationOnce(async () => {
      expect(save).toHaveBeenCalledTimes(1);
      return { ok: true, appWithoutWebhook: false };
    });
    await put();
    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe("desconectar quita el webhook que puso el guardado", () => {
  beforeEach(() => {
    creds.current = {
      wabaId: "111",
      phoneNumberId: "222",
      token: "EAAG-token",
      status: "connected",
      displayPhoneNumber: "+52 55 0000 0000",
      verifiedName: "Negocio",
    };
  });

  it("lo quita ANTES de borrar el token, comparando por la ruta fija", async () => {
    unregister.mockImplementationOnce(async () => {
      expect(disconnect).not.toHaveBeenCalled();
    });
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(unregister).toHaveBeenCalledWith({
      phoneNumberId: "222",
      token: "EAAG-token",
      webhookPath: "/api/webhooks/wa/verify-abc",
    });
    expect(disconnect).toHaveBeenCalledWith("org_a");
  });

  it("sin conexión no llama a Meta y responde 200 igual (idempotente)", async () => {
    creds.current = null;
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(unregister).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith("org_a");
  });
});

describe("«Registrar en Meta» con la conexión guardada", () => {
  it("sin conexión → 409", async () => {
    const res = await webhookPost();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("sin_conexion");
    expect(register).not.toHaveBeenCalled();
  });

  it("con conexión → registra con el token guardado y la URL fija", async () => {
    creds.current = {
      wabaId: "111",
      phoneNumberId: "222",
      token: "EAAG-guardado",
      status: "connected",
      displayPhoneNumber: null,
      verifiedName: null,
    };
    register.mockResolvedValueOnce({ ok: true, appWithoutWebhook: true });
    const res = await webhookPost();
    expect(res.status).toBe(200);
    expect(register).toHaveBeenCalledWith({
      wabaId: "111",
      phoneNumberId: "222",
      token: "EAAG-guardado",
      webhookUrl: URL_FIJA,
      verifyToken: "verify-abc",
    });
    expect(await res.json()).toEqual({ ok: true, appWithoutWebhook: true });
  });

  it("si Meta dice que no, devuelve el motivo con 422 (503 si Meta está caída)", async () => {
    creds.current = {
      wabaId: "111",
      phoneNumberId: "222",
      token: "EAAG-guardado",
      status: "connected",
      displayPhoneNumber: null,
      verifiedName: null,
    };
    register.mockResolvedValueOnce({ ok: false, code: "missing_permission", message: "sin permiso" });
    const rechazo = await webhookPost();
    expect(rechazo.status).toBe(422);
    expect((await rechazo.json()).error).toEqual({ code: "missing_permission", message: "sin permiso" });

    register.mockResolvedValueOnce({ ok: false, code: "meta_unavailable", message: "caída" });
    expect((await webhookPost()).status).toBe(503);
  });

  it("GET sigue enseñando la URL fija y el verify token para el respaldo manual", async () => {
    const res = await webhookGet();
    expect(await res.json()).toMatchObject({
      url: URL_FIJA,
      verifyToken: "verify-abc",
      isHttps: true,
      signatureLayer: false,
      instagramUrl: null,
      messengerUrl: null,
    });
  });
});
