import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { envSchema } from "@/lib/env";

/**
 * #88 — Um manifest por plataforma (Render, Fly, Railway) para implantar a
 * imagem publicada fora do Coolify com um comando. Cada um declara o que
 * sua plataforma permite declarar (porta 3000, healthcheck /api/health,
 * volume em /data, imagem fixada na versão) e documenta, em comentários,
 * o que fica por conta própria. As variáveis obrigatórias saem do mesmo esquema
 * que valida o arranque (src/lib/env.ts): se alguém acrescentar uma nova,
 * isto fica vermelho até que os três manifests a tragam, declarada ou no
 * comando que a fixa.
 */

const RAIZ = path.resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(
  readFileSync(path.join(RAIZ, "package.json"), "utf8")
) as { version: string };
const IMAGEN = `ghcr.io/kevinrivm/vocero-crm:${pkg.version}`;

// Um checkout do Windows com autocrlf deixa CRLF: normaliza-se para que as
// expressões com `\n` leiam o mesmo em qualquer máquina.
const leer = (nombre: string) =>
  readFileSync(path.join(RAIZ, nombre), "utf8").replace(/\r\n?/g, "\n");
/** Só o que a plataforma lê: sem as linhas de comentário. */
const sinComentarios = (texto: string) =>
  texto
    .split("\n")
    .filter((linea) => !/^\s*#/.test(linea))
    .join("\n");

// Obrigatória = sem `.optional()` nem `.default()`. `isOptional()` apenas testa
// `undefined` contra o tipo: não lê o ambiente nem deixa nada em cache.
const OBLIGATORIAS = Object.entries(envSchema.shape)
  .filter(([, tipo]) => !tipo.isOptional())
  .map(([clave]) => clave);

const render = leer("render.yaml");
const fly = leer("fly.toml");
const railway = leer("railway.toml");

/** O bloco YAML de uma variável do render.yaml: desde o seu `- key:` até o próximo. */
function bloqueRender(clave: string): string {
  const m = render.match(
    new RegExp(`^\\s*- key: ${clave}\\n((?:(?!\\s*- key:).*\\n)*)`, "m")
  );
  expect(m, `render.yaml declara ${clave}`).not.toBeNull();
  return m?.[1] ?? "";
}

describe("las variables obligatorias salen del esquema real", () => {
  it("son las cinco sin default", () => {
    expect(OBLIGATORIAS).toEqual(
      expect.arrayContaining([
        "APP_BASE_URL",
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "ENCRYPTION_KEY",
        "META_WEBHOOK_VERIFY_TOKEN",
      ])
    );
    expect(OBLIGATORIAS).not.toContain("META_GRAPH_API_VERSION");
    expect(OBLIGATORIAS).not.toContain("MEDIA_DIR");
  });
});

describe.each([
  ["render.yaml", render],
  ["fly.toml", fly],
  ["railway.toml", railway],
])("%s: lo común a los tres", (_nombre, texto) => {
  it("nombra cada variable obligatoria, declarada o en el comando que la fija", () => {
    for (const clave of OBLIGATORIAS) {
      expect(texto, clave).toMatch(new RegExp(`\\b${clave}\\b`));
    }
  });

  it("fija la imagen publicada a la versión de package.json", () => {
    // Como o compose (tests/unit/version.test.ts): uma etiqueta antiga num
    // manifest instala a versão anterior enquanto o CHANGELOG fala da
    // nova.
    expect(texto).toContain(IMAGEN);
    expect(texto).not.toMatch(/vocero-crm:latest/);
  });

  it("apunta al healthcheck, al volumen de /data y al puerto de la imagen", () => {
    expect(texto).toContain("/api/health");
    expect(texto).toContain("/data");
    expect(texto).toMatch(/\b3000\b/);
  });

  it("no define MEDIA_DIR: la imagen ya trae /data/media dentro del volumen", () => {
    // Defini-la na plataforma é exatamente como se enviam os anexos
    // fora do volume (INSTALL-IA.md, «Diagnóstico rápido»).
    expect(sinComentarios(texto)).not.toMatch(/MEDIA_DIR\s*[=:]/);
  });

  it("genera cada secreto con el comando que pide .env.example", () => {
    // ENCRYPTION_KEY são 32 bytes em base64; o verify token vai na URL do
    // webhook, então é hex (sem `/`). Ou a plataforma o gera nesse
    // mesmo formato, ou o comando documentado o faz.
    expect(texto).toMatch(/ENCRYPTION_KEY[\s\S]{0,200}(openssl rand -base64 32|generateValue: true)/);
    expect(texto).toMatch(/META_WEBHOOK_VERIFY_TOKEN[\s\S]{0,300}openssl rand -hex 32/);
  });
});

describe("render.yaml: el Blueprint declara todo lo que Render deja declarar", () => {
  const activo = sinComentarios(render);

  it("servicio web desde la imagen, con healthcheck y disco en /data", () => {
    expect(activo).toMatch(/^\s*runtime: image$/m);
    expect(activo).toMatch(new RegExp(`^\\s*url: ${IMAGEN.replace(/[.]/g, "\\.")}$`, "m"));
    expect(activo).toMatch(/^\s*healthCheckPath: \/api\/health$/m);
    expect(activo).toMatch(/^\s*mountPath: \/data$/m);
  });

  it("fija PORT=3000: Render mete PORT=10000 por defecto y la imagen escucha en 3000", () => {
    expect(bloqueRender("PORT")).toMatch(/value: "3000"/);
  });

  it("cada variable obligatoria es una entrada real de envVars", () => {
    for (const clave of OBLIGATORIAS) {
      expect(activo, clave).toMatch(new RegExp(`^\\s*- key: ${clave}$`, "m"));
    }
  });

  it("DATABASE_URL viene de la base del Blueprint y APP_BASE_URL de la URL del servicio", () => {
    expect(bloqueRender("DATABASE_URL")).toMatch(/fromDatabase:[\s\S]*name: vocero-db[\s\S]*property: connectionString/);
    expect(activo).toMatch(/^databases:\n\s*- name: vocero-db$/m);
    expect(bloqueRender("APP_BASE_URL")).toMatch(/fromService:[\s\S]*envVarKey: RENDER_EXTERNAL_URL/);
  });

  it("los secretos los genera Render (256 bits base64 = los 32 bytes de ENCRYPTION_KEY)", () => {
    expect(bloqueRender("BETTER_AUTH_SECRET")).toMatch(/generateValue: true/);
    expect(bloqueRender("ENCRYPTION_KEY")).toMatch(/generateValue: true/);
  });

  it("el verify token NO se genera: en base64 llevaría `/` y es un segmento de la URL del webhook", () => {
    const bloque = bloqueRender("META_WEBHOOK_VERIFY_TOKEN");
    expect(bloque).toMatch(/sync: false/);
    expect(sinComentarios(bloque)).not.toMatch(/generateValue/);
  });

  it("la base no queda abierta a cualquier IP", () => {
    expect(activo).toMatch(/^\s*ipAllowList: \[\]$/m);
  });
});

describe("fly.toml: lo que cabe en el archivo y los comandos de lo que no", () => {
  const activo = sinComentarios(fly);

  it("imagen publicada, volumen en /data, puerto 3000 y healthcheck", () => {
    expect(activo).toMatch(new RegExp(`^\\s*image = "${IMAGEN.replace(/[.]/g, "\\.")}"$`, "m"));
    expect(activo).toMatch(/^\s*destination = "\/data"$/m);
    expect(activo).toMatch(/^\s*internal_port = 3000$/m);
    expect(activo).toMatch(/^\s*path = "\/api\/health"$/m);
  });

  it("APP_BASE_URL va en [env] y coincide con el nombre de la app", () => {
    const app = activo.match(/^app = "([^"]+)"$/m)?.[1];
    expect(app).toBeTruthy();
    expect(activo).toMatch(new RegExp(`^\\s*APP_BASE_URL = "https://${app}\\.fly\\.dev"$`, "m"));
  });

  it("la máquina no se apaga sola: el agente, el Laboratorio y el SSE corren dentro del proceso", () => {
    expect(activo).toMatch(/^\s*auto_stop_machines = "off"$/m);
  });

  it("los secretos van por `fly secrets set` y DATABASE_URL por `attach`", () => {
    for (const clave of ["BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "META_WEBHOOK_VERIFY_TOKEN"]) {
      expect(fly).toMatch(new RegExp(`fly secrets set[\\s\\S]{0,300}${clave}=`));
      // E não em [env], que é visível no fly.toml do repo.
      expect(activo, clave).not.toMatch(new RegExp(`^\\s*${clave} =`, "m"));
    }
    expect(fly).toMatch(/fly postgres attach vocero-db --app vocero-crm/);
    expect(fly).toMatch(/fly volumes create vocero_data --app vocero-crm/);
  });
});

describe("railway.toml: solo build, healthcheck y reinicio; el resto, con la CLI", () => {
  const activo = sinComentarios(railway);

  it("construye desde el Dockerfile con healthcheck y reinicio ante fallos", () => {
    expect(activo).toMatch(/^\s*builder = "DOCKERFILE"$/m);
    expect(activo).toMatch(/^\s*healthcheckPath = "\/api\/health"$/m);
    expect(activo).toMatch(/^\s*restartPolicyType = "ON_FAILURE"$/m);
  });

  it("documenta la base, el volumen en /data, el dominio al puerto 3000 y cada variable", () => {
    expect(railway).toMatch(/railway add --database postgres/);
    expect(railway).toMatch(/railway volume add --mount-path \/data/);
    expect(railway).toMatch(/railway domain --port 3000/);
    for (const clave of OBLIGATORIAS) {
      expect(railway, clave).toMatch(new RegExp(`railway variable set[\\s\\S]{0,600}${clave}=`));
    }
    expect(railway).toMatch(/DATABASE_URL=\$\{\{Postgres\.DATABASE_URL\}\}/);
    expect(railway).toMatch(/APP_BASE_URL=https:\/\/\$\{\{RAILWAY_PUBLIC_DOMAIN\}\}/);
  });
});

describe("la documentación lleva a los manifests", () => {
  it("el README tiene la sección y enlaza los tres; INSTALL-IA.md apunta a ella", () => {
    const readme = leer("README.md");
    expect(readme).toMatch(/^### Otras plataformas/m);
    for (const archivo of ["render.yaml", "fly.toml", "railway.toml"]) {
      expect(readme).toContain(`](${archivo})`);
    }
    expect(leer("INSTALL-IA.md")).toMatch(/Otras plataformas/);
  });
});
