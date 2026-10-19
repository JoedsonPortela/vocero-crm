import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * Ficha de qualificação do lead: o que o cérebro externo vai descobrindo
 * na conversa.
 *
 * As chaves NÃO estão fixas. Cada negócio qualifica de um jeito — uma clínica
 * pergunta o tratamento, uma construtora os metros, uma agência o
 * orçamento — e o CRM não precisa migrar a cada vez que alguém muda seu
 * questionário. O que o CRM impõe é que o guardado seja saudável: escalares,
 * limitados e em número razoável.
 *
 * A validação é FROUXA de propósito. Do outro lado há um LLM que deriva: hoje
 * manda `dolor_principal` e amanhã `dolorPrincipal`, ou um `"sim"` onde antes
 * mandava `true`. Devolver-lhe um 422 jogaria fora dados reais de qualificação que já
 * custaram uma conversa; prefere-se guardar o que se entende e ignorar
 * em silêncio o que não.
 */

/** Limite de chaves por ficha: contém um bot em loop sem atrapalhar ninguém. */
const MAX_KEYS = 40;
const MAX_KEY_LEN = 60;
const MAX_VALUE_LEN = 500;

export type FichaInput = Record<string, unknown>;
export type Ficha = Record<string, string | number | boolean | null>;

/**
 * Deixa a ficha em valores que possam ser guardados e exibidos: escalares
 * limitados. `null` sobrevive porque significa "apague esta chave". Objetos,
 * arranjos e chaves absurdas são ignorados sem erro.
 */
export function normalizeFicha(raw: FichaInput): Ficha {
  const out: Ficha = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [rawKey, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_KEYS) break;

    const key = rawKey.trim();
    if (!key || key.length > MAX_KEY_LEN) continue;

    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const v = value.trim();
      // A string vazia não apaga: para isso existe o `null` explícito. Um LLM envia
      // "" com facilidade demais para deixar que ela jogue fora um dado bom.
      if (v) out[key] = v.slice(0, MAX_VALUE_LEN);
      continue;
    }
    // Objetos e arranjos: fora. São ignorados sem erro (ver acima).
  }
  return out;
}

/** Merge campo a campo: o ausente se mantém, `null` explícito apaga. */
export function mergeFicha(prev: Ficha | null | undefined, patch: Ficha): Ficha {
  const out: Ficha = { ...(prev ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * Escreve a ficha. É a ÚNICA porta: por aqui passa o cérebro externo
 * (`PUT /api/bot/ficha`) e também o dono pela caixa de entrada, então os dois
 * herdam o mesmo merge —`null` apaga— e os mesmos limites.
 *
 * Merge e não substituição porque os dois escrevem ao mesmo tempo: o bot vai
 * preenchendo enquanto conversa e o dono corrige o que vê. Com substituição, quem
 * salvar por último apagaria o trabalho do outro sem que ninguém percebesse.
 *
 * Devolve `null` se o contato não existir nessa organização.
 */
export async function upsertFicha(input: {
  organizationId: string;
  contactId: string;
  ficha: FichaInput;
}): Promise<{ ficha: Ficha } | null> {
  const db = getDb();
  const patch = normalizeFicha(input.ficha);

  // O limite fica aqui e não em cada chamador: uma ficha é informação de
  // qualificação de um cliente alheio, e confiar em que quem chama lembre
  // de filtrar por organização é exatamente como se vazam dados entre
  // inquilinos.
  const alcance = scoped(
    schema.contact.organizationId,
    input.organizationId,
    eq(schema.contact.id, input.contactId)
  );

  const rows = await db
    .select({ ficha: schema.contact.ficha })
    .from(schema.contact)
    .where(alcance)
    .limit(1);
  if (!rows[0]) return null;

  const merged = mergeFicha(rows[0].ficha as Ficha | null, patch);

  await db
    .update(schema.contact)
    .set({ ficha: merged, updatedAt: new Date() })
    .where(alcance);

  return { ficha: merged };
}

/**
 * 026 — Esvazia a ficha inteira. Só para quando se apaga a conversa da qual
 * ela saiu (`server/inbox/eliminar.ts`): a ficha é o que o agente foi
 * aprendendo, e viaja ao cérebro a cada turno.
 *
 * Recebe o executor para rodar DENTRO da transação da exclusão: esvaziar
 * a ficha de um fio que no fim não foi apagado seria perder dados à toa.
 */
export async function vaciarFicha(
  ejecutor: Pick<ReturnType<typeof getDb>, "update">,
  organizationId: string,
  contactId: string
): Promise<void> {
  await ejecutor
    .update(schema.contact)
    .set({ ficha: null, updatedAt: new Date() })
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    );
}

export function serializeFicha(
  contact: typeof schema.contact.$inferSelect
): Ficha {
  return (contact.ficha as Ficha | null) ?? {};
}
