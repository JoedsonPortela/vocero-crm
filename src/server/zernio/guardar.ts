import { apiError } from "@/lib/api";
import { MetaApiError } from "@/lib/meta/client";
import {
  fetchZernioAccounts,
  pickZernioAccount,
  type ZernioAccount,
  type ZernioChannel,
} from "@/server/zernio/cuentas";

/**
 * 023 — O passo que as três telas compartilham ao salvar uma conexão pela
 * Zernio: verificar a chave e decidir de qual conta se trata (D1 da spec).
 *
 * Uma só leitura de `GET /accounts` faz as duas coisas: uma chave que não
 * serve responde 401, e a lista diz qual conta é a do canal. Devolve a
 * resposta de erro já montada para que as três rotas respondam igual.
 */
export async function resolveZernioAccount(
  token: string,
  accountRef: string | null | undefined,
  channel: ZernioChannel
): Promise<{ ok: true; account: ZernioAccount } | { ok: false; response: Response }> {
  let accounts: ZernioAccount[];
  try {
    accounts = await fetchZernioAccounts(token);
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err;
    // Sem resposta, 5xx ou limite de requisições: não diz nada sobre a chave.
    if (err.status === 0 || err.status >= 500 || err.status === 429) {
      return {
        ok: false,
        response: apiError(
          503,
          "platform_unavailable",
          "No se pudo contactar a Zernio; intenta de nuevo"
        ),
      };
    }
    return {
      ok: false,
      response: apiError(422, "invalid_token", "La API key de Zernio no es válida"),
    };
  }

  const pick = pickZernioAccount(accounts, accountRef, channel);
  if (pick.ok) return { ok: true, account: pick.account };
  return {
    ok: false,
    response: Response.json(
      {
        error: {
          code: pick.code,
          message: pick.message,
          // Só id e nome: é o que a tela precisa para oferecê-las.
          details: { accounts: pick.candidates },
        },
      },
      { status: 422 }
    ),
  };
}
