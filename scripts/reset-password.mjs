/**
 * Redefinir a senha de um usuário SEM e-mail.
 *
 * O Vocero não tem fluxo de "esqueci minha senha" — seria uma dependência
 * externa, e a constituição as proíbe na v1; além disso o registro público
 * fecha assim que existe a primeira organização. Quando a senha se perde, a
 * única saída é reescrever o hash no banco.
 *
 * Este script NÃO toca em nenhum banco de dados: não abre conexão, não lê
 * DATABASE_URL, não escreve nada. Gera o hash e imprime o `UPDATE` pronto
 * para colar. Quem decide aplicá-lo é uma pessoa com acesso ao servidor, que
 * é exatamente a barreira que se quer para uma operação assim.
 *
 * Uso (bash):
 *   NEW_PASSWORD='sua-senha-nova' node scripts/reset-password.mjs email@exemplo.com
 *
 * Uso (PowerShell):
 *   $env:NEW_PASSWORD='sua-senha-nova'; node scripts/reset-password.mjs email@exemplo.com
 */
import { hashPassword, verifyPassword } from "better-auth/crypto";

/** Mesmo mínimo que pede o registro; não faz sentido abrir uma porta mais fraca. */
const MIN_PASSWORD_LENGTH = 8;

const email = process.argv[2];
// Por variável de ambiente e não por argumento: um argumento fica no
// histórico do shell e é visível em `ps` para qualquer outro usuário da
// máquina enquanto o processo roda. Num servidor costuma haver mais de uma
// sessão aberta.
const password = process.env.NEW_PASSWORD;

if (!email || !password) {
  console.error(
    "Faltan datos.\n" +
      "  bash:       NEW_PASSWORD='...' node scripts/reset-password.mjs correo@ejemplo.com\n" +
      "  PowerShell: $env:NEW_PASSWORD='...'; node scripts/reset-password.mjs correo@ejemplo.com"
  );
  process.exit(1);
}

if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(
    `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
  );
  process.exit(1);
}

// O hash sai de `better-auth/crypto`, a MESMA função com que o login
// verifica. Reimplementar o scrypt aqui significaria duplicar seus parâmetros: o
// dia em que a biblioteca mudá-los, este script continuaria gerando hashes antigos
// e o login os rejeitaria sem dizer por quê — justamente o cenário que este
// script existe para resolver, e com o usuário já fora da própria conta.
const hash = await hashPassword(password);

// Verifica-se o hash recém-gerado antes de imprimir qualquer coisa. Vale mais falhar
// aqui do que deixar alguém colando um `UPDATE` que o deixa igualmente de fora.
if (!(await verifyPassword({ hash, password }))) {
  console.error(
    "El hash generado no se verifica a sí mismo. NO uses el SQL: algo cambió " +
      "en la versión de Better Auth y hay que revisarlo."
  );
  process.exit(1);
}

/** Escapa um valor para um literal SQL entre aspas simples. */
const lit = (value) => value.replace(/'/g, "''");

// `lower(email)` porque o e-mail pode ter sido salvo com maiúsculas, e um
// `UPDATE 0` silencioso é pior que um erro: parece que funcionou.
const sql =
  `UPDATE "account" SET "password" = '${lit(hash)}', "updated_at" = now() ` +
  `WHERE "provider_id" = 'credential' AND "user_id" = ` +
  `(SELECT "id" FROM "user" WHERE lower("email") = lower('${lit(email)}'));`;

console.log(`
Hash verificado. Pega este comando en la terminal del contenedor de Postgres
(en Coolify: el recurso de la base → pestaña Terminal):

psql -U postgres -d vocero -c "${sql.replace(/"/g, '\\"')}"

Debe responder: UPDATE 1
Si responde UPDATE 0, el correo no coincide. Míralos con:
psql -U postgres -d vocero -c 'SELECT email FROM "user";'
`);
