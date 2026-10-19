import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";

/**
 * `scripts/reset-password.mjs` é a única porta de volta quando alguém
 * perde sua senha: não há recuperação por e-mail e o registro público
 * se fecha com a primeira organização.
 *
 * Por isso se testa rodando-o de verdade como subprocesso, igual a como o roda
 * uma pessoa, em vez de importar suas peças: `scripts/**` fica fora do
 * eslint e do tsconfig, então este arquivo é a ÚNICA cobertura automática
 * que tem. O que se verifica é o que importa — que o hash que imprime
 * realmente deixe entrar.
 */

const exec = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/reset-password.mjs");
const TIMEOUT = 20_000;

/** Extrai o hash `salt:chave` do SQL que o script imprime. */
function hashDeLaSalida(stdout: string): string | null {
  return stdout.match(/'([0-9a-f]{32}:[0-9a-f]{128})'/)?.[1] ?? null;
}

async function correr(args: string[], password?: string) {
  const env = { ...process.env };
  delete env.NEW_PASSWORD;
  if (password !== undefined) env.NEW_PASSWORD = password;
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("reset-password", () => {
  it(
    "el hash que imprime deja entrar con esa contraseña y no con otra",
    async () => {
      const password = "una-contrasena-nueva-123";
      const { code, stdout } = await correr(["duena@ejemplo.com"], password);
      expect(code).toBe(0);

      const hash = hashDeLaSalida(stdout);
      expect(hash).not.toBeNull();

      // O único que de fato importa: o better-auth aceita esse hash.
      expect(await verifyPassword({ hash: hash!, password })).toBe(true);
      expect(await verifyPassword({ hash: hash!, password: "otra-cosa-999" })).toBe(false);
    },
    TIMEOUT
  );

  it(
    "acentos y eñes sobreviven el viaje (normalización NFKC)",
    async () => {
      const password = "contraseña-única-ñandú";
      const { code, stdout } = await correr(["duena@ejemplo.com"], password);
      expect(code).toBe(0);
      expect(await verifyPassword({ hash: hashDeLaSalida(stdout)!, password })).toBe(true);
    },
    TIMEOUT
  );

  it("un hash generado antes sigue verificando (canario de formato)", async () => {
    // Congelado de propósito. Se uma versão futura do better-auth mudar o
    // formato ou os parâmetros do scrypt, isto fica vermelho AQUI — antes de
    // que as senhas já salvas deixem de funcionar em produção e
    // ninguém consiga entrar para consertar.
    const congelado =
      "181acaf1397646b882722b5b5b7f71e7:b8106a42eb4765159f070a73f3bb5cd2f8839753da5b959dc4096a88e6af95a2622146a025f42c10cf6865fbbd065ecdc04766f19c0ba90992fff8080a5c847e";
    expect(
      await verifyPassword({ hash: congelado, password: "canario-de-formato-vocero" })
    ).toBe(true);
  });

  it(
    "el SQL apunta a la credencial del usuario, no a toda la tabla",
    async () => {
      const { stdout } = await correr(["duena@ejemplo.com"], "una-contrasena-nueva-123");
      // As aspas são escapadas porque o SQL viaja dentro de `psql -c "…"`.
      expect(stdout).toContain(`\\"provider_id\\" = 'credential'`);
      expect(stdout).toContain(`lower(\\"email\\") = lower('duena@ejemplo.com')`);
      // Sem WHERE delimitado, um reset daria a mesma senha a toda a
      // equipe — um incidente de segurança disfarçado de resgate.
      expect(stdout).toContain("WHERE");
      expect(stdout.match(/UPDATE \\"account\\"/g)).toHaveLength(1);
    },
    TIMEOUT
  );

  it(
    "una comilla en el correo se escapa en vez de romper el SQL",
    async () => {
      const { code, stdout } = await correr(["o'brien@ejemplo.com"], "una-contrasena-nueva-123");
      expect(code).toBe(0);
      expect(stdout).toContain("o''brien@ejemplo.com");
    },
    TIMEOUT
  );

  describe("guardas", () => {
    it("sin argumentos no imprime SQL y sale con error", async () => {
      const { code, stdout, stderr } = await correr([]);
      expect(code).toBe(1);
      expect(stdout).not.toContain("UPDATE");
      expect(stderr).toContain("NEW_PASSWORD");
    });

    it("sin correo tampoco, aunque haya contraseña", async () => {
      const { code, stdout } = await correr([], "una-contrasena-nueva-123");
      expect(code).toBe(1);
      expect(stdout).not.toContain("UPDATE");
    });

    it("una contraseña corta se rechaza antes de generar nada", async () => {
      const { code, stdout, stderr } = await correr(["duena@ejemplo.com"], "corta");
      expect(code).toBe(1);
      expect(stdout).not.toContain("UPDATE");
      expect(stderr).toContain("8 caracteres");
    });
  });
});
