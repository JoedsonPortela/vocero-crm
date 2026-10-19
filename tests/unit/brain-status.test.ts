import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainDispatchDto, BrainHealthDto } from "@/lib/brain-status";
import {
  SIN_DESPACHO,
  externalAnswerLabel,
  externalAnswering,
  externalBrainName,
  externalDown,
  haceCuanto,
} from "@/lib/brain-status";
import { resetRateLimit } from "@/lib/rate-limit";
import { isBotKeyConfigured, requireBotKey } from "@/server/bot/auth";
import {
  BRAIN_HEALTH_TTL_MS,
  EXTERNAL_SEEN_WINDOW_MS,
  botLastSeenAt,
  computeBrainStatus,
  fetchBrainHealth,
  getBrainHealth,
  markBotSeen,
  resetBrainStatusState,
  type BrainStatusInput,
} from "@/server/bot/status";

/**
 * «Quién responde a tus clientes». O que se protege: que o dono saiba se
 * responde o agente incluído, seu cérebro externo (Nea), os dois (o cliente
 * recebe duas respostas) ou ninguém — e que perguntar à Nea jamais trave a
 * tela nem vaze a URL com seus segredos.
 */

const NOW = new Date("2026-09-21T18:00:00.000Z");
const HACE_3_MIN = new Date(NOW.getTime() - 3 * 60_000);
const HACE_25_H = new Date(NOW.getTime() - 25 * 3_600_000);

const EN_LINEA: BrainHealthDto = {
  reachable: true,
  host: "nea:8000",
  checkedAt: NOW.toISOString(),
  version: "1.0.0",
  mode: "estándar",
};
const CAIDA: BrainHealthDto = {
  reachable: false,
  host: "nea:8000",
  checkedAt: NOW.toISOString(),
  problem: "timeout",
};

function status(over: Partial<BrainStatusInput>) {
  return computeBrainStatus({
    aiConfigured: false,
    agentEnabled: false,
    botKeyConfigured: false,
    lastSeenAt: null,
    health: null,
    now: NOW,
    ...over,
  });
}

const DESPACHANDO: BrainDispatchDto = {
  ...SIN_DESPACHO,
  active: true,
  host: "nea:8000",
};

describe("computeBrainStatus — con el despacho (021)", () => {
  it("sin despacho, la llave nueva es la de una instancia que no despacha", () => {
    expect(status({}).dispatch).toEqual(SIN_DESPACHO);
  });

  it("activo: calla al agente incluido aunque tenga IA e interruptor, y no hay doble respuesta", () => {
    const s = status({
      aiConfigured: true,
      agentEnabled: true,
      botKeyConfigured: true,
      lastSeenAt: HACE_3_MIN,
      health: EN_LINEA,
      dispatch: DESPACHANDO,
    });
    expect(s.embedded).toEqual({ configured: true, enabled: true, answering: false, silenced: true });
    expect(s.external.active).toBe(true);
    expect(s.warning).toBeNull();
    expect(s.dispatch).toEqual(DESPACHANDO);
  });

  it("activo y sin una sola llamada todavía: el cerebro cuenta como el que contesta", () => {
    const s = status({ botKeyConfigured: true, dispatch: DESPACHANDO });
    expect(s.external.active).toBe(true);
    expect(s.embedded.silenced).toBe(false);
    expect(s.warning).toBeNull();
    expect(externalAnswering(s)).toBe(true);
  });

  it("activo pero con el /health caído: sigue sin aviso de doble respuesta, y se ve caído", () => {
    const s = status({
      aiConfigured: true,
      agentEnabled: true,
      botKeyConfigured: true,
      health: CAIDA,
      dispatch: DESPACHANDO,
    });
    expect(s.warning).toBeNull();
    expect(externalDown(s)).toBe(true);
  });

  it("mal configurado NO calla al agente incluido: todo sigue como en 1.5", () => {
    const roto: BrainDispatchDto = { ...SIN_DESPACHO, host: "nea:8000", problem: "sin_llave" };
    const s = status({ aiConfigured: true, agentEnabled: true, dispatch: roto });
    expect(s.embedded).toEqual({ configured: true, enabled: true, answering: true, silenced: false });
    expect(s.external.active).toBe(false);
    expect(s.dispatch.problem).toBe("sin_llave");
  });
});

describe("computeBrainStatus — los casos que ve el dueño", () => {
  it("solo Nea: llave usada hace 3 min, agente incluido apagado → sin aviso", () => {
    const s = status({ botKeyConfigured: true, lastSeenAt: HACE_3_MIN, health: EN_LINEA });
    expect(s.embedded).toEqual({ configured: false, enabled: false, answering: false, silenced: false });
    expect(s.external.active).toBe(true);
    expect(s.external.lastSeenAt).toBe(HACE_3_MIN.toISOString());
    expect(s.warning).toBeNull();
  });

  it("solo el agente incluido: token + interruptor, sin llave → sin aviso", () => {
    const s = status({ aiConfigured: true, agentEnabled: true });
    expect(s.embedded.answering).toBe(true);
    expect(s.external).toEqual({ keyConfigured: false, lastSeenAt: null, active: false, health: null });
    expect(s.warning).toBeNull();
  });

  it("los dos contestando → doble_respuesta (por la llamada reciente)", () => {
    const s = status({ aiConfigured: true, agentEnabled: true, botKeyConfigured: true, lastSeenAt: HACE_3_MIN });
    expect(s.warning).toBe("doble_respuesta");
  });

  it("los dos contestando → doble_respuesta (por el /health, aunque no haya llamado)", () => {
    const s = status({ aiConfigured: true, agentEnabled: true, botKeyConfigured: true, health: EN_LINEA });
    expect(s.warning).toBe("doble_respuesta");
  });

  it("nadie: sin agente incluido y sin llave → sin_cerebro", () => {
    expect(status({}).warning).toBe("sin_cerebro");
    // Desligado de propósito com token: também não responde ninguém.
    expect(status({ aiConfigured: true }).warning).toBe("sin_cerebro");
  });

  it("el interruptor encendido sin token NO contesta", () => {
    const s = status({ agentEnabled: true });
    expect(s.embedded).toEqual({ configured: false, enabled: true, answering: false, silenced: false });
    expect(s.warning).toBe("sin_cerebro");
  });

  it("Nea en línea pero sin llave: no puede hablar por el CRM → sin_cerebro", () => {
    const s = status({ health: EN_LINEA });
    expect(s.external.active).toBe(true);
    expect(s.warning).toBe("sin_cerebro");
  });

  it("llave sin ninguna llamada desde el arranque: no cuenta como activo", () => {
    const s = status({ aiConfigured: true, agentEnabled: true, botKeyConfigured: true });
    expect(s.external.active).toBe(false);
    expect(s.warning).toBeNull();
  });

  it("una llamada de hace 25 h ya no cuenta; justo 24 h todavía sí", () => {
    const base = { aiConfigured: true, agentEnabled: true, botKeyConfigured: true };
    expect(status({ ...base, lastSeenAt: HACE_25_H }).warning).toBeNull();
    const justo = new Date(NOW.getTime() - EXTERNAL_SEEN_WINDOW_MS);
    expect(status({ ...base, lastSeenAt: justo }).warning).toBe("doble_respuesta");
  });

  it("un /health caído no cuenta como activo, pero la llamada reciente sí", () => {
    const base = { aiConfigured: true, agentEnabled: true, botKeyConfigured: true };
    expect(status({ ...base, health: CAIDA }).warning).toBeNull();
    expect(status({ ...base, health: CAIDA, lastSeenAt: HACE_3_MIN }).warning).toBe("doble_respuesta");
  });

  it("todas las combinaciones cumplen las tres reglas", () => {
    const bools = [false, true];
    const vistos = [null, HACE_3_MIN, HACE_25_H];
    const healths = [null, EN_LINEA, CAIDA];
    let n = 0;
    for (const aiConfigured of bools)
      for (const agentEnabled of bools)
        for (const botKeyConfigured of bools)
          for (const lastSeenAt of vistos)
            for (const health of healths) {
              const s = status({ aiConfigured, agentEnabled, botKeyConfigured, lastSeenAt, health });
              const answering = aiConfigured && agentEnabled;
              const active =
                (botKeyConfigured && lastSeenAt === HACE_3_MIN) || health === EN_LINEA;
              expect(s.embedded.answering).toBe(answering);
              expect(s.external.active).toBe(active);
              expect(s.warning).toBe(
                answering && active
                  ? "doble_respuesta"
                  : !answering && !botKeyConfigured
                    ? "sin_cerebro"
                    : null
              );
              n++;
            }
    expect(n).toBe(72);
  });
});

describe("textos compartidos", () => {
  it("«Nea» solo si su /health habla el contrato de Nea", () => {
    const conNea = status({ botKeyConfigured: true, health: EN_LINEA });
    expect(externalBrainName(conNea)).toBe("Nea");
    expect(externalAnswerLabel(conNea)).toBe("Responde seu cérebro externo (Nea)");
    const sinNombre = status({ botKeyConfigured: true, lastSeenAt: HACE_3_MIN });
    expect(externalBrainName(sinNombre)).toBeNull();
    expect(externalAnswerLabel(sinNombre)).toBe("Responde seu cérebro externo");
  });

  it("«responde tu cerebro externo» solo si no está caído; el aviso doble no espera a eso", () => {
    const sano = status({ botKeyConfigured: true, lastSeenAt: HACE_3_MIN, health: EN_LINEA });
    expect(externalAnswering(sano)).toBe(true);
    expect(externalDown(sano)).toBe(false);
    // Chamou há 3 min, mas seu /health não responde: segue «activo» para o
    // aviso de dupla resposta, mas não se diz ao dono que responde.
    const caido = status({ botKeyConfigured: true, lastSeenAt: HACE_3_MIN, health: CAIDA });
    expect(caido.external.active).toBe(true);
    expect(externalAnswering(caido)).toBe(false);
    expect(externalDown(caido)).toBe(true);
    // Sem BRAIN_HEALTH_URL vale a chamada recente.
    const sinHealth = status({ botKeyConfigured: true, lastSeenAt: HACE_3_MIN });
    expect(externalAnswering(sinHealth)).toBe(true);
    expect(externalDown(sinHealth)).toBe(false);
  });

  it("con BRAIN_HEALTH_URL mal escrita no se le da por caído: manda la llamada reciente", () => {
    const mal: BrainHealthDto = { reachable: false, host: "", checkedAt: NOW.toISOString(), problem: "config" };
    const llamo = status({ botKeyConfigured: true, lastSeenAt: HACE_3_MIN, health: mal });
    expect(externalDown(llamo)).toBe(false);
    expect(externalAnswering(llamo)).toBe(true);
    const callado = status({ botKeyConfigured: true, lastSeenAt: null, health: mal });
    expect(externalDown(callado)).toBe(false);
    expect(externalAnswering(callado)).toBe(false);
  });

  it("haceCuanto", () => {
    const t = NOW.getTime();
    expect(haceCuanto(new Date(t - 20_000).toISOString(), t)).toBe("hace unos segundos");
    expect(haceCuanto(new Date(t + 60_000).toISOString(), t)).toBe("hace unos segundos");
    expect(haceCuanto(HACE_3_MIN.toISOString(), t)).toBe("hace 3 min");
    expect(haceCuanto(new Date(t - 2 * 3_600_000).toISOString(), t)).toBe("hace 2 h");
    expect(haceCuanto(HACE_25_H.toISOString(), t)).toBe("hace 1 día");
  });
});

describe("la última llamada del cerebro externo (requireBotKey)", () => {
  const KEY = "clave-de-servicio-larga-0123456789abcdef";
  const req = (key?: string) =>
    new Request("http://localhost/api/bot/context", {
      headers: key ? { "x-api-key": key } : {},
    });

  beforeEach(() => {
    vi.stubEnv("BOT_API_KEY", KEY);
    resetRateLimit();
    resetBrainStatusState();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("solo una llamada autenticada la anota", () => {
    expect(botLastSeenAt()).toBeNull();
    expect(requireBotKey(req())?.status).toBe(401);
    expect(requireBotKey(req("otra-clave-igual-de-larga-pero-mala!!"))?.status).toBe(401);
    expect(botLastSeenAt()).toBeNull();
    const antes = Date.now();
    expect(requireBotKey(req(KEY))).toBeNull();
    expect(botLastSeenAt()!.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it("vive en memoria del proceso (compartida entre rutas)", () => {
    markBotSeen(HACE_3_MIN.getTime());
    expect(botLastSeenAt()?.toISOString()).toBe(HACE_3_MIN.toISOString());
  });

  it("una key corta equivale a no tener llave", () => {
    expect(isBotKeyConfigured()).toBe(true);
    vi.stubEnv("BOT_API_KEY", "corta");
    expect(isBotKeyConfigured()).toBe(false);
    vi.stubEnv("BOT_API_KEY", "");
    expect(isBotKeyConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// O /health, contra um servidor HTTP de verdade
// ---------------------------------------------------------------------------

let server: Server;
let base = "";
let hitsDestino = 0;
let ultimaEco: { authorization?: string; url?: string } = {};

const NEA = {
  ok: true,
  version: "1.0.0",
  commit: "abc1234",
  commitVerified: true,
  mode: "estándar",
  relay: { pendientes: 0, masViejoSegundos: null, ultimoErrorEn: null },
};

function json(res: import("node:http").ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const path = (req.url ?? "").split("?")[0];
    switch (path) {
      case "/nea":
        return json(res, 200, NEA);
      case "/nea-real": // lo que de verdad manda Nea: `status`, no `ok`
        return json(res, 200, { status: "ok", db: "ok", version: "1.1.0", mode: "cloud" });
      case "/vieja":
        return json(res, 200, { status: "ok", db: "ok" });
      case "/degradada":
        return json(res, 503, { status: "degraded", db: "error", version: "1.1.0", mode: "estándar" });
      case "/500":
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("Internal Server Error");
      case "/html":
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html><body>ok</body></html>");
      case "/sin-ok":
        return json(res, 200, { version: "1.0.0" });
      case "/arreglo":
        return json(res, 200, [{ ok: true }]);
      case "/redirige":
        res.writeHead(302, { location: "/destino" });
        return res.end();
      case "/destino":
        hitsDestino++;
        return json(res, 200, NEA);
      case "/cuelga":
        return; // nunca responde
      case "/grande": {
        res.writeHead(200, { "content-type": "application/json" }); // sem content-length
        res.write(`{"ok":true,"relleno":"`);
        res.write("x".repeat(100 * 1024));
        return res.end(`"}`);
      }
      case "/raro":
        return json(res, 200, {
          ok: true,
          version: 123,
          commit: "no-es-hex!",
          commitVerified: "sí",
          mode: "turbo",
          relay: { pendientes: -1, masViejoSegundos: "x", ultimoErrorEn: "ayer" },
        });
      case "/tolerante":
        return json(res, 200, {
          ok: true,
          version: "  v2.0.0  ",
          mode: "Estandar",
          relay: { pendientes: 2.7, masViejoSegundos: 95, ultimoErrorEn: "2026-09-21T17:55:00+00:00" },
        });
      case "/eco":
        ultimaEco = { authorization: req.headers.authorization, url: req.url };
        return json(res, 200, NEA);
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("fetchBrainHealth", () => {
  it("Nea sana con el contrato completo → en línea con versión, modo y relevo", async () => {
    const h = await fetchBrainHealth(`${base}/nea`);
    expect(h).toMatchObject({
      reachable: true,
      host: base.replace("http://", ""),
      version: "1.0.0",
      commit: "abc1234",
      commitVerified: true,
      mode: "estándar",
      relay: { pendientes: 0, masViejoSegundos: null, ultimoErrorEn: null },
    });
    expect(h.problem).toBeUndefined();
    expect(Date.parse(h.checkedAt)).not.toBeNaN();
  });

  it("la Nea de hoy manda `status: \"ok\"` en vez de `ok` → también en línea", async () => {
    const h = await fetchBrainHealth(`${base}/nea-real`);
    expect(h).toMatchObject({ reachable: true, version: "1.1.0", mode: "cloud" });
  });

  it("una Nea vieja (solo `status`) → en línea, sin inventar versión ni modo", async () => {
    const h = await fetchBrainHealth(`${base}/vieja`);
    expect(h.reachable).toBe(true);
    expect(h.version).toBeUndefined();
    expect(h.mode).toBeUndefined();
    expect(h.relay).toBeUndefined();
  });

  it("503 degradada → no en línea, pero conserva quién es", async () => {
    const h = await fetchBrainHealth(`${base}/degradada`);
    expect(h).toMatchObject({
      reachable: false,
      problem: "status",
      httpStatus: 503,
      version: "1.1.0",
      mode: "estándar",
    });
  });

  it("500 en texto plano → problem status 500", async () => {
    const h = await fetchBrainHealth(`${base}/500`);
    expect(h).toMatchObject({ reachable: false, problem: "status", httpStatus: 500 });
  });

  it("200 que no es JSON, JSON sin `ok`, o un arreglo → invalid", async () => {
    for (const p of ["/html", "/sin-ok", "/arreglo"]) {
      const h = await fetchBrainHealth(`${base}${p}`);
      expect(h, p).toMatchObject({ reachable: false, problem: "invalid" });
    }
  });

  it("una redirección NO se sigue", async () => {
    hitsDestino = 0;
    const h = await fetchBrainHealth(`${base}/redirige`);
    expect(h).toMatchObject({ reachable: false, problem: "redirect", httpStatus: 302 });
    expect(hitsDestino).toBe(0);
  });

  it("si no contesta, se rinde a tiempo (timeout) y no lanza", async () => {
    const t0 = Date.now();
    const h = await fetchBrainHealth(`${base}/cuelga`, { timeoutMs: 200 });
    expect(h).toMatchObject({ reachable: false, problem: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("puerto cerrado → network", async () => {
    const libre = createServer();
    await new Promise<void>((r) => libre.listen(0, "127.0.0.1", r));
    const port = (libre.address() as AddressInfo).port;
    await new Promise<void>((r) => libre.close(() => r()));
    const h = await fetchBrainHealth(`http://127.0.0.1:${port}/health`);
    expect(h).toMatchObject({ reachable: false, problem: "network", host: `127.0.0.1:${port}` });
  });

  it("una URL mal escrita ni se intenta → config, sin host", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["nea:8000/health", "ftp://nea/health", "no es una url"]) {
      const h = await fetchBrainHealth(url, { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(h).toMatchObject({ reachable: false, host: "", problem: "config" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("un cuerpo enorme no se lee entero → invalid", async () => {
    const h = await fetchBrainHealth(`${base}/grande`);
    expect(h).toMatchObject({ reachable: false, problem: "invalid" });
  });

  it("campos con basura se descartan; los tolerables se normalizan", async () => {
    const raro = await fetchBrainHealth(`${base}/raro`);
    expect(raro.reachable).toBe(true);
    expect(raro).not.toHaveProperty("version");
    expect(raro).not.toHaveProperty("commit");
    expect(raro).not.toHaveProperty("commitVerified");
    expect(raro).not.toHaveProperty("mode");
    expect(raro).not.toHaveProperty("relay");

    const tol = await fetchBrainHealth(`${base}/tolerante`);
    expect(tol).toMatchObject({
      version: "v2.0.0",
      mode: "estándar",
      relay: { pendientes: 2, masViejoSegundos: 95, ultimoErrorEn: "2026-09-21T17:55:00.000Z" },
    });
  });

  it("credenciales y query de la URL: se usan, pero jamás salen en la respuesta", async () => {
    const port = base.split(":").pop();
    const h = await fetchBrainHealth(
      `http://usuario:s3cr3t-pass@127.0.0.1:${port}/eco?token=tok-secreto`
    );
    expect(h.reachable).toBe(true);
    // As credenciais viajam como Basic (fetch rejeita uma URL que as traz)…
    expect(ultimaEco.authorization).toBe(
      `Basic ${Buffer.from("usuario:s3cr3t-pass").toString("base64")}`
    );
    expect(ultimaEco.url).toBe("/eco?token=tok-secreto");
    // …e da URL só volta o host.
    expect(h.host).toBe(`127.0.0.1:${port}`);
    const dump = JSON.stringify(h);
    for (const secreto of ["s3cr3t", "usuario", "tok-secreto", "token", "/eco"]) {
      expect(dump).not.toContain(secreto);
    }
  });
});

describe("getBrainHealth (caché de 15 s)", () => {
  beforeEach(() => resetBrainStatusState());

  function contador() {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    return { fetchImpl, llamadas: () => n };
  }

  it("sin BRAIN_HEALTH_URL no le pregunta a nadie", async () => {
    const c = contador();
    expect(await getBrainHealth(undefined, { fetchImpl: c.fetchImpl })).toBeNull();
    expect(c.llamadas()).toBe(0);
  });

  it("reutiliza la respuesta 15 s y después vuelve a preguntar", async () => {
    const c = contador();
    let t = 1_000_000;
    const opts = { fetchImpl: c.fetchImpl, clock: () => t };
    await getBrainHealth("http://nea:8000/health", opts);
    t += BRAIN_HEALTH_TTL_MS - 1;
    await getBrainHealth("http://nea:8000/health", opts);
    expect(c.llamadas()).toBe(1);
    t += 2;
    await getBrainHealth("http://nea:8000/health", opts);
    expect(c.llamadas()).toBe(2);
  });

  it("llamadas simultáneas comparten una sola pregunta", async () => {
    const c = contador();
    const opts = { fetchImpl: c.fetchImpl };
    const rs = await Promise.all([
      getBrainHealth("http://nea:8000/health", opts),
      getBrainHealth("http://nea:8000/health", opts),
      getBrainHealth("http://nea:8000/health", opts),
    ]);
    expect(c.llamadas()).toBe(1);
    expect(rs.every((r) => r?.reachable === true)).toBe(true);
  });
});
