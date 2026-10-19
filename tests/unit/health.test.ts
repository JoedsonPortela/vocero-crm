import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #82 — `/api/health` diz quais flags estão ligadas e se o volume de
 * anexos pode ser escrito. É o que uma plataforma ou um script pode
 * confirmar com um `curl`, sem iniciar sessão: que `AGENDA=on` chegou ao
 * contêiner, que `/data` ficou bem montado. E a imagem deixa de levar o que
 * o migrador nunca abre.
 */

const RAIZ = path.resolve(import.meta.dirname, "..", "..");

const { getEnv, getDb } = vi.hoisted(() => ({
  getEnv: vi.fn(),
  getDb: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ getEnv }));
vi.mock("@/lib/db", () => ({ getDb, schema: {} }));

import { checkHealth, healthFeatures } from "@/server/health";
import {
  MEDIA_DIR_PROBE_TTL_MS,
  mediaDirStatus,
  resetMediaDirCache,
} from "@/server/media-dir";
import { GET } from "@/app/api/health/route";

const ENV_ORIGINAL = { ...process.env };
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "vocero-health-"));
  resetMediaDirCache();
  getDb.mockReturnValue({ execute: async () => [] });
  getEnv.mockReturnValue({ MEDIA_DIR: path.join(tmp, "media") });
});

afterEach(async () => {
  process.env = { ...ENV_ORIGINAL };
  await rm(tmp, { recursive: true, force: true });
});

describe("features: las banderas de despliegue", () => {
  it("sin banderas: solo WhatsApp, agenda y atribución apagadas", () => {
    expect(healthFeatures({})).toEqual({
      agenda: false,
      channels: ["whatsapp"],
      atribucion: false,
    });
  });

  it("con las tres encendidas, los canales van en el orden del catálogo", () => {
    // O da variável não: duas instâncias iguais têm que responder igual.
    expect(
      healthFeatures({
        AGENDA: "on",
        CHANNELS: "messenger, Instagram",
        ATRIBUCION: "1",
      })
    ).toEqual({
      agenda: true,
      channels: ["whatsapp", "instagram", "messenger"],
      atribucion: true,
    });
  });

  it("un typo no enciende nada: dice lo que la app hace, no lo que se escribió", () => {
    // Os mesmos parsers que as rotas usam para responder 404: se aqui dissesse
    // `true` e a agenda respondesse 404, o health mentiria.
    expect(
      healthFeatures({ AGENDA: "onn", CHANNELS: "telegram", ATRIBUCION: "off" })
    ).toEqual({ agenda: false, channels: ["whatsapp"], atribucion: false });
  });
});

describe("mediaWritable: el volumen de adjuntos", () => {
  it("escribible → true, y el sondeo no deja rastro", async () => {
    const r = await checkHealth();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mediaWritable: true });
    expect(await readdir(path.join(tmp, "media"))).toEqual([]);
  });

  it("no escribible → false, pero `ok` sigue en true y el código en 200", async () => {
    // Um healthcheck em vermelho reiniciaria em loop um contêiner que atende
    // clientes: sem anexos o CRM funciona, e isto só o torna visível.
    const archivo = path.join(tmp, "no-soy-directorio");
    await writeFile(archivo, "x");
    getEnv.mockReturnValue({ MEDIA_DIR: path.join(archivo, "media") });

    const r = await checkHealth();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mediaWritable: false });
  });

  it("no escribe en cada llamada: el sondeo se recuerda un minuto", async () => {
    const dir = path.join(tmp, "media");
    const t0 = 1_000_000;
    expect((await mediaDirStatus(t0))?.writable).toBe(true);

    // O diretório some e em seu lugar há um arquivo: uma sondagem nova
    // diria false. Dentro do minuto responde-se o lembrado; depois, não.
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "x");
    expect((await mediaDirStatus(t0 + MEDIA_DIR_PROBE_TTL_MS - 1))?.writable).toBe(true);
    expect((await mediaDirStatus(t0 + MEDIA_DIR_PROBE_TTL_MS))?.writable).toBe(false);
  });

  it("si MEDIA_DIR cambia, se sondea el nuevo aunque el anterior esté fresco", async () => {
    const t0 = 1_000_000;
    expect((await mediaDirStatus(t0))?.writable).toBe(true);

    const archivo = path.join(tmp, "no-soy-directorio");
    await writeFile(archivo, "x");
    getEnv.mockReturnValue({ MEDIA_DIR: path.join(archivo, "media") });
    expect((await mediaDirStatus(t0 + 1))?.writable).toBe(false);
  });

  it("sin entorno válido no hay directorio que sondear", async () => {
    getEnv.mockImplementation(() => {
      throw new Error("Variables de entorno inválidas");
    });
    expect(await mediaDirStatus()).toBeNull();
  });
});

describe("GET /api/health", () => {
  it("200 con la forma completa: lo de siempre más features y mediaWritable", async () => {
    process.env.AGENDA = "on";
    process.env.CHANNELS = "instagram";
    delete process.env.ATRIBUCION;

    const res = await GET();
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({
      ok: true,
      features: { agenda: true, channels: ["whatsapp", "instagram"], atribucion: false },
      mediaWritable: true,
    });
    expect(typeof cuerpo.version).toBe("string");
    // Os campos de antes seguem na frente: quem já lê `ok` e `version` não
    // percebe a mudança.
    expect(Object.keys(cuerpo).slice(0, 2)).toEqual(["ok", "version"]);
  });

  it("BD caída: 503 y la misma respuesta de antes, sin features", async () => {
    getDb.mockReturnValue({
      execute: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "db_unavailable", message: "Base de datos no disponible" },
    });
  });
});

describe("la imagen no lleva lo que el migrador no lee", () => {
  it("el migrador de drizzle-orm abre meta/_journal.json y los .sql, nada más", () => {
    // Se uma versão nova do drizzle-orm começasse a ler os snapshots em
    // runtime, o .dockerignore abaixo quebraria as migrações do
    // arranque: isto pega antes.
    const migrador = readFileSync(
      path.join(RAIZ, "node_modules", "drizzle-orm", "migrator.js"),
      "utf8"
    );
    expect(migrador).toContain("meta/_journal.json");
    expect(migrador).toContain(".sql");
    expect(migrador).not.toMatch(/snapshot/i);
  });

  it("scripts/migrate.mjs tampoco los toca", () => {
    const script = readFileSync(path.join(RAIZ, "scripts", "migrate.mjs"), "utf8");
    expect(script).toContain("drizzle-orm/postgres-js/migrator");
    expect(script).not.toMatch(/snapshot/i);
  });

  it(".dockerignore deja fuera meta/ salvo el journal, y los .sql se quedan", () => {
    const lineas = readFileSync(path.join(RAIZ, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const excluye = lineas.indexOf("drizzle/meta/*");
    const conserva = lineas.indexOf("!drizzle/meta/_journal.json");
    expect(excluye).toBeGreaterThanOrEqual(0);
    // A exceção tem que vir DEPOIS: no .dockerignore vale a última
    // regra que casa.
    expect(conserva).toBeGreaterThan(excluye);
    expect(lineas.some((l) => /^drizzle\/?\*?$/.test(l) || l.endsWith(".sql"))).toBe(false);
  });
});
