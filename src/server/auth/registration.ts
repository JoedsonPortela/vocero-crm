import { count } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Cadastro público fechado após a primeira organização (FR-060), salvo a
 * variável de escape ALLOW_SIGNUP=true. As contas de equipe as cria o
 * proprietário (bypass interno do gate).
 */
export async function isPublicSignupAllowed(): Promise<boolean> {
  if (process.env.ALLOW_SIGNUP === "true") return true;
  const db = getDb();
  const rows = await db.select({ n: count() }).from(schema.organization);
  return (rows[0]?.n ?? 0) === 0;
}
