import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A versão que a app exibe tem que ser a do código que está rodando. Se ela
 * dessincronizar, é pior que não tê-la: alguém vai depurar meia hora um bug
 * já corrigido porque a etiqueta disse que o build tinha chegado.
 */

const RAIZ = path.resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(
  readFileSync(path.join(RAIZ, "package.json"), "utf8")
) as { version: string };

describe("versión de la app", () => {
  it("package.json lleva un SemVer válido", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("no la duplica nadie: sale de package.json vía next.config", () => {
    const config = readFileSync(path.join(RAIZ, "next.config.ts"), "utf8");
    expect(config).toContain("package.json");
    expect(config).toContain("NEXT_PUBLIC_APP_VERSION");
    // Uma versão escrita à mão no config é exatamente como se
    // dessincroniza; se aparecer um literal tipo "1.2.3", isto fica vermelho.
    expect(config).not.toMatch(/["']\d+\.\d+\.\d+["']/);
  });

  it("la insignia no cablea el nombre del producto", () => {
    // Isto é white-label: uma instância renomeada que diz "Vocero" no
    // tooltip denuncia o produto de baixo justo onde o operador olha
    // todos os dias.
    const nav = readFileSync(
      path.join(RAIZ, "src", "components", "app-nav.tsx"),
      "utf8"
    );
    // Procura-se a chamada real. Antes buscava `versionLabel()`, que não existe
    // no componente (chama-se com o commit): o índice era -1 e o teste
    // olhava, por acaso, o final do arquivo.
    const llamada = nav.indexOf("versionLabel(version.commit)");
    expect(llamada).toBeGreaterThan(0);
    const insignia = nav.slice(llamada - 600, llamada + 300);
    expect(insignia).toContain("branding.name");
    expect(insignia).not.toMatch(/`Vocero \$\{/);
  });

  it("docker compose arranca por defecto la imagen de esta misma versión", () => {
    // O compose é o único outro lugar com a versão escrita: fixa a imagem
    // publicada. Se o package.json sobe e o compose não, `docker compose up -d`
    // roda a versão anterior enquanto o código e o CHANGELOG falam da
    // nova.
    const compose = readFileSync(path.join(RAIZ, "docker-compose.yml"), "utf8");
    const imagen = compose.match(/image:\s*\S+:\$\{VOCERO_CRM_VERSION:-([^}\s]+)\}/);
    expect(imagen?.[1]).toBe(pkg.version);
  });

  it("el Dockerfile acepta el commit sin exigirlo", () => {
    const dockerfile = readFileSync(path.join(RAIZ, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG SOURCE_COMMIT");
    // Com default vazio: quem constrói sem passá-lo não deve ver um build quebrado.
    expect(dockerfile).toMatch(/ARG SOURCE_COMMIT=""/);
  });
});

describe("versionLabel", () => {
  it("resuelve el commit de la plataforma cuando el build no lo trajo… SIN verificar", async () => {
    // Há plataformas que publicam `SOURCE_COMMIT` no contêiner sem
    // passá-lo ao build. Sem este respaldo, a insígnia mostra só a versão,
    // que não muda entre implantações do mesmo release. Mas esse commit é
    // a palavra da plataforma: se ninguém o atualiza, mente (#50).
    process.env.NEXT_PUBLIC_APP_VERSION = "1.4.2";
    process.env.NEXT_PUBLIC_BUILD_COMMIT = "";
    process.env.SOURCE_COMMIT = "abcdef1234567890";
    const m = await import(`@/lib/version?plat=${Date.now()}`);
    expect(m.resolveCommit()).toEqual({ commit: "abcdef1", verified: false });
    expect(m.versionLabel(m.resolveCommit().commit)).toBe("v1.4.2 · abcdef1");
  });

  it("el del build MANDA sobre el de la plataforma, y es el único verificado", async () => {
    // Se os dois existem, o congelado na imagem é o que de fato
    // corresponde ao código que roda.
    process.env.NEXT_PUBLIC_APP_VERSION = "1.4.2";
    process.env.NEXT_PUBLIC_BUILD_COMMIT = "1111111aaaa";
    process.env.SOURCE_COMMIT = "2222222bbbb";
    const m = await import(`@/lib/version?both=${Date.now()}`);
    expect(m.resolveCommit()).toEqual({ commit: "1111111", verified: true });
  });

  it("sin ninguno de los dos, solo la versión", async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.4.2";
    process.env.NEXT_PUBLIC_BUILD_COMMIT = "";
    delete process.env.SOURCE_COMMIT;
    const m = await import(`@/lib/version?none=${Date.now()}`);
    expect(m.resolveCommit()).toEqual({ commit: "", verified: false });
    expect(m.versionLabel(m.resolveCommit().commit)).toBe("v1.4.2");
  });

  it("con commit muestra los dos; sin commit, solo la versión", async () => {
    // O módulo lê `process.env` ao ser importado, então cada caso precisa do
    // seu próprio import fresco.
    process.env.NEXT_PUBLIC_APP_VERSION = "1.4.2";
    process.env.NEXT_PUBLIC_BUILD_COMMIT = "8e62d0bdfe5a7fb";
    const conCommit = await import(`@/lib/version?con=${Date.now()}`);
    expect(conCommit.versionLabel()).toBe("v1.4.2 · 8e62d0b");

    process.env.NEXT_PUBLIC_BUILD_COMMIT = "";
    const sinCommit = await import(`@/lib/version?sin=${Date.now()}`);
    expect(sinCommit.versionLabel()).toBe("v1.4.2");
  });
});

/**
 * #50, ponto 4 — A insígnia pode mentir em silêncio.
 *
 * Uma instância mostrava `v1.3.0 · 52c5034` e rodava `73e93c1`, 14 commits
 * à frente: o `SOURCE_COMMIT` estava escrito à mão na plataforma e
 * ninguém o atualizava, e o respaldo de execução o apresentava igual a um
 * congelado no build. Agora diz o que é.
 */
describe("un commit que no salió del build se presenta como NO verificado", () => {
  const ENV_ORIGINAL = { ...process.env };
  // O módulo lê `process.env` ao ser importado: cada caso, um import fresco.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
    vi.resetModules();
  });

  it("el tooltip lo dice, con de dónde salió y cómo verificarlo", async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.3.0";
    process.env.NEXT_PUBLIC_BUILD_COMMIT = "";
    process.env.SOURCE_COMMIT = "52c5034aaaa";
    const m = await import("@/lib/version");
    const titulo = m.versionTitle("Clínica Sur", m.resolveCommit());
    expect(titulo).toContain("52c5034");
    expect(titulo).toContain("no viene del build");
    expect(titulo).toContain("build arg SOURCE_COMMIT");
    // White-label também aqui: o nome é o da marca.
    expect(titulo.startsWith("Clínica Sur 1.3.0")).toBe(true);
    expect(titulo).not.toContain("Vocero");
  });

  it("el verificado no lleva advertencia; sin commit, solo nombre y versión", async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.3.0";
    process.env.NEXT_PUBLIC_BUILD_COMMIT = "73e93c1bbbb";
    const m = await import("@/lib/version");
    expect(m.versionTitle("Clínica Sur", m.resolveCommit())).toBe(
      "Clínica Sur 1.3.0, construido del commit 73e93c1"
    );
    expect(m.versionTitle("Clínica Sur", { commit: "", verified: false })).toBe(
      "Clínica Sur 1.3.0"
    );
  });

  it("la insignia pinta la advertencia SOLO para un commit sin verificar", () => {
    const nav = readFileSync(
      path.join(RAIZ, "src", "components", "app-nav.tsx"),
      "utf8"
    );
    expect(nav).toMatch(
      /\{version\.commit && !version\.verified && \([\s\S]{0,400}UNVERIFIED_COMMIT_NOTE/
    );
  });

  describe("/api/health", () => {
    // Aqui só importa o commit: a forma completa (com `features` e
    // `mediaWritable`, #82) é testada em tests/unit/health.test.ts.
    // Cada caso reimporta a rota com `resetModules` (lê o ambiente ao
    // ser importada): numa execução carregada isso pode passar dos 5 s de
    // série, e um teste que expira segue rodando por trás do seguinte.
    const IMPORT_FRESCO_MS = 30_000;

    async function salud(env: Record<string, string | undefined>) {
      vi.resetModules();
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.doMock("@/lib/db", () => ({
        getDb: () => ({ execute: async () => [] }),
      }));
      const { GET } = await import("@/app/api/health/route");
      return (await GET()).json();
    }

    it("commit del build → commitVerified: true", async () => {
      expect(
        await salud({
          NEXT_PUBLIC_APP_VERSION: "1.3.0",
          NEXT_PUBLIC_BUILD_COMMIT: "73e93c1bbbb",
          SOURCE_COMMIT: "52c5034aaaa",
        })
      ).toMatchObject({ ok: true, version: "1.3.0", commit: "73e93c1", commitVerified: true });
    }, IMPORT_FRESCO_MS);

    it("commit solo del entorno → sale, pero con commitVerified: false", async () => {
      // `commit` se mantém: há scripts que já o leem e não se quebram.
      expect(
        await salud({
          NEXT_PUBLIC_APP_VERSION: "1.3.0",
          NEXT_PUBLIC_BUILD_COMMIT: "",
          SOURCE_COMMIT: "52c5034aaaa",
        })
      ).toMatchObject({ ok: true, version: "1.3.0", commit: "52c5034", commitVerified: false });
    }, IMPORT_FRESCO_MS);

    it("sin commit por ningún lado → solo la versión, sin afirmar nada", async () => {
      const cuerpo = await salud({
        NEXT_PUBLIC_APP_VERSION: "1.3.0",
        NEXT_PUBLIC_BUILD_COMMIT: "",
        SOURCE_COMMIT: undefined,
      });
      expect(cuerpo).toMatchObject({ ok: true, version: "1.3.0" });
      expect(cuerpo).not.toHaveProperty("commit");
      expect(cuerpo).not.toHaveProperty("commitVerified");
    }, IMPORT_FRESCO_MS);
  });
});
