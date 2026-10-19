import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_SCOPE, googleConnector } from "@/server/agenda/connectors/google";
import { clearGoogleTokenCache } from "@/server/agenda/connectors/google-credentials";

/**
 * 015 / issue #50, pontos 2 e 3 — As duas falhas do conector do Google que
 * fazem conectá-lo parecer quebrado quando não está.
 *
 * As duas se verificam pela FRONTEIRA de rede: o que importa não é como se
 * chama a função interna, mas em qual endpoint se chama e quantas vezes se
 * pede o token. Um teste acoplado aos nomes passaria com o bug posto assim que
 * alguém renomeasse algo.
 */

const CREDS = {
  clientId: "cid",
  clientSecret: "secreto-1",
  refreshToken: "refresh-1",
  calendarId: "primary",
} as never;

let llamadas: string[] = [];

function responder(url: string): Response {
  llamadas.push(url);
  if (url.includes("/token")) {
    return new Response(
      JSON.stringify({ access_token: `tok-${llamadas.length}`, expires_in: 3600 }),
      { status: 200 }
    );
  }
  return new Response(JSON.stringify({ summary: "Mi calendario" }), {
    status: 200,
  });
}

beforeEach(() => {
  llamadas = [];
  clearGoogleTokenCache();
  // `getEnv()` valida o ambiente inteiro: sem o mínimo, o conector falha
  // antes de tocar a rede e o teste mediria outra coisa.
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
  vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
  vi.stubEnv("GOOGLE_OAUTH_BASE_URL", "https://oauth.test");
  vi.stubEnv("GOOGLE_CAL_BASE_URL", "https://cal.test");
  globalThis.fetch = ((url: string) =>
    Promise.resolve(responder(String(url)))) as typeof fetch;
});

describe("punto 2 — la prueba de conexión cabe en el scope documentado", () => {
  /**
   * `GET /calendars/{id}` é `Calendars.Get`, e o Google só o concede com
   * `calendar.readonly` ou superior. Com o escopo que este conector pede de
   * fato, essa chamada devolvia 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT: a
   * conexão funcionava e o próprio teste dela falhava.
   */
  it("lista eventos en vez de leer el calendario", async () => {
    const r = await googleConnector.testConnection!(CREDS);
    expect(r.ok).toBe(true);

    const api = llamadas.filter((u) => !u.includes("/token"));
    expect(api).toHaveLength(1);
    expect(api[0]).toContain("/events");
    // A chamada que exigia mais permissão do que a documentada.
    expect(api[0]).not.toMatch(/\/calendars\/[^/]+$/);
  });

  it("y el scope que se pide sigue siendo el mínimo", () => {
    // Se um dia fosse preciso `readonly`, este teste obriga a dizê-lo aqui
    // e no guia da tela, em vez de descobri-lo com um 403.
    expect(GOOGLE_SCOPE).toBe("https://www.googleapis.com/auth/calendar.events");
  });
});

describe("punto 3 — el caché del token distingue credenciales", () => {
  it("las mismas credenciales reutilizan el token (el caché sirve)", async () => {
    await googleConnector.testConnection!(CREDS);
    await googleConnector.testConnection!(CREDS);
    expect(llamadas.filter((u) => u.includes("/token"))).toHaveLength(1);
  });

  /**
   * O sintoma real: depois de regenerar o refresh token, o teste seguia
   * devolvendo o MESMO erro, palavra por palavra, durante uma hora. O
   * operador conclui que o token novo também está errado.
   */
  it("un refresh token distinto pide un token NUEVO, sin esperar a que expire", async () => {
    await googleConnector.testConnection!(CREDS);
    await googleConnector.testConnection!({
      ...(CREDS as object),
      refreshToken: "refresh-2",
    } as never);
    expect(llamadas.filter((u) => u.includes("/token"))).toHaveLength(2);
  });

  it("y cambiar solo el secreto también cuenta", async () => {
    await googleConnector.testConnection!(CREDS);
    await googleConnector.testConnection!({
      ...(CREDS as object),
      clientSecret: "secreto-2",
    } as never);
    expect(llamadas.filter((u) => u.includes("/token"))).toHaveLength(2);
  });
});
