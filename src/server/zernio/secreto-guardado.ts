import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * 030 — O segredo de assinatura da Zernio, criptografado em repouso.
 *
 * Instagram, Messenger e TikTok guardam o segredo HMAC das entregas da
 * Zernio em três colunas criptografadas (`webhook_secret_{cipher,iv,tag}`), com o
 * mesmo AES-256-GCM do token da linha. Até a 1.6 ia em texto claro em
 * `webhook_secret`: essa coluna já não é gravada, só é lida como reserva
 * enquanto a inicialização não a tiver criptografado (spec 030, D5), e é removida numa
 * versão maior (D6).
 */

type ColumnasDelSecreto = {
  webhookSecret: string | null;
  webhookSecretCipher: string | null;
  webhookSecretIv: string | null;
  webhookSecretTag: string | null;
};

/**
 * O que se grava na linha para guardar `secret`: criptografado, e a coluna
 * antiga em nulo. É a única porta que grava essas colunas.
 */
export function columnasDelSecreto(secret: string | null): ColumnasDelSecreto {
  if (!secret) {
    return {
      webhookSecret: null,
      webhookSecretCipher: null,
      webhookSecretIv: null,
      webhookSecretTag: null,
    };
  }
  const enc = encryptSecret(secret);
  return {
    webhookSecret: null,
    webhookSecretCipher: enc.cipher,
    webhookSecretIv: enc.iv,
    webhookSecretTag: enc.tag,
  };
}

/** O segredo de uma linha: o criptografado se houver; senão, o que ficou em texto claro. */
export function secretoDeLaFila(row: ColumnasDelSecreto): string | null {
  if (row.webhookSecretCipher && row.webhookSecretIv && row.webhookSecretTag) {
    return decryptSecret({
      cipher: row.webhookSecretCipher,
      iv: row.webhookSecretIv,
      tag: row.webhookSecretTag,
    });
  }
  return row.webhookSecret || null;
}

const TABLAS = [
  schema.instagramCredentials,
  schema.messengerCredentials,
  schema.tiktokCredentials,
] as const;

/**
 * Criptografa os segredos que uma versão anterior deixou em texto claro. Re-executável:
 * só olha linhas com `webhook_secret`, e cada uma é escrita com a condição
 * de que ainda tenha o valor lido, então um segredo gravado entre a
 * leitura e a escrita (que já chega criptografado) não é sobrescrito. Devolve quantas
 * linhas criptografou; nunca diz quais nem com o quê.
 */
export async function cifrarSecretosEnClaro(): Promise<number> {
  const db = getDb();
  let cifrados = 0;
  for (const tabla of TABLAS) {
    const filas = await db
      .select({ id: tabla.id, secreto: tabla.webhookSecret })
      .from(tabla)
      .where(isNotNull(tabla.webhookSecret));
    for (const fila of filas) {
      if (fila.secreto === null) continue;
      const hechas = await db
        .update(tabla)
        .set(columnasDelSecreto(fila.secreto))
        .where(and(eq(tabla.id, fila.id), eq(tabla.webhookSecret, fila.secreto)))
        .returning({ id: tabla.id });
      // Um "" é limpo igual, mas não era um segredo.
      if (fila.secreto) cifrados += hechas.length;
    }
  }
  return cifrados;
}
