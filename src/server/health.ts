import { sql } from "drizzle-orm";
import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import { getDb } from "@/lib/db";
import { APP_VERSION, resolveCommit } from "@/lib/version";
import { parseAgendaFlag } from "@/server/agenda/flag";
import { parseAtribucionFlag } from "@/server/attribution/flag";
import { parseChannels } from "@/server/channels/enabled";
import { mediaDirStatus } from "@/server/media-dir";

/**
 * `GET /api/health` — o que uma plataforma, um script ou um `curl` podem
 * saber da instância sem abrir o app nem iniciar sessão.
 *
 * `ok` e o código HTTP dizem UMA coisa: se o banco de dados responde. É o
 * que o healthcheck do Docker verifica para reiniciar o contêiner, e nada de
 * o demais deve movê-lo.
 *
 * A versão viaja aqui de propósito: confirmar uma implantação precisa poder
 * ser feita a partir de um pipeline, e é a única forma de verificar que o build
 * que subiu é o que roda. `commitVerified` diz de onde saiu `commit`:
 * `true` se foi congelado no build, `false` se é o `SOURCE_COMMIT` que a
 * plataforma colocou no ambiente — que pode estar defasado (#50). Um
 * pipeline que compare commits precisa exigir `true`; `commit` continua ali
 * igual, para não quebrar quem já o lê.
 *
 * `features` (#82) diz quais bandeiras de implantação estão ligadas: a
 * forma de confirmar que `AGENDA=on` chegou ao contêiner sem abrir Configurações.
 * São lidas de `process.env` direto, igual a `agendaEnabled()`, e não por
 * `getEnv()`: a esta altura o BD já respondeu (e com ele validou o
 * ambiente), mas a pergunta de se uma funcionalidade existe nunca depende disso.
 *
 * `mediaWritable` (#82) diz se `MEDIA_DIR` pode ser escrito. NÃO rebaixa `ok`
 * nem o código: o CRM funciona sem anexos, e um healthcheck vermelho
 * reiniciaria em loop um contêiner que atende clientes. O que muda é
 * que um volume mal montado aparece de fora, e não num 500 ao subir o
 * logo.
 */

export type HealthFeatures = {
  /** Motor de agenda (015): bandeira `AGENDA`. */
  agenda: boolean;
  /** Canais ligados (014/017): bandeira `CHANNELS`; `whatsapp` sempre. */
  channels: Channel[];
  /** Atribuição de anúncios e CAPI (016): bandeira `ATRIBUCION`. */
  atribucion: boolean;
};

export type HealthOk = {
  ok: true;
  version: string;
  commit?: string;
  commitVerified?: boolean;
  features: HealthFeatures;
  mediaWritable: boolean;
};

export type HealthDown = {
  ok: false;
  error: { code: "db_unavailable"; message: string };
};

export type HealthResult =
  | { status: 200; body: HealthOk }
  | { status: 503; body: HealthDown };

/**
 * As três variáveis de implantação que decidem o que existe na instância.
 * O índice serve para que `process.env` encaixe sem cast (e o resto é ignorado).
 */
export type FlagEnv = {
  AGENDA?: string;
  CHANNELS?: string;
  ATRIBUCION?: string;
  [otra: string]: string | undefined;
};

/**
 * As bandeiras, com os mesmos parsers que usam as rotas para decidir se uma
 * superfície existe: o que diz aqui é o que o app faz. Os canais seguem
 * a ordem do catálogo, não a da variável, para que duas instâncias
 * iguais respondam igual.
 */
export function healthFeatures(env: FlagEnv = process.env): HealthFeatures {
  const channels = parseChannels(env.CHANNELS);
  return {
    agenda: parseAgendaFlag(env.AGENDA),
    channels: CHANNEL_ORDER.filter((c) => channels.has(c)),
    atribucion: parseAtribucionFlag(env.ATRIBUCION),
  };
}

export async function checkHealth(): Promise<HealthResult> {
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        error: { code: "db_unavailable", message: "Base de datos no disponible" },
      },
    };
  }
  const { commit, verified } = resolveCommit();
  const media = await mediaDirStatus();
  return {
    status: 200,
    body: {
      ok: true,
      version: APP_VERSION,
      ...(commit ? { commit, commitVerified: verified } : {}),
      features: healthFeatures(),
      mediaWritable: media?.writable ?? false,
    },
  };
}
