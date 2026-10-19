import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/lib/env";

/**
 * 008 / #82 — Pode-se escrever em MEDIA_DIR?
 *
 * É a pergunta que decide se os anexos recebidos, o logo e o ícone vão
 * ser guardados. Responde-se escrevendo DE VERDADE (o mesmo que fará
 * `saveMediaFile`) e apagando o rastro, não olhando permissões.
 *
 * Fazem-na dois lugares: a inicialização (`instrumentation-node.ts`, que avisa no
 * log) e `/api/health` (que a expõe como `mediaWritable`). O
 * healthcheck do Docker bate a cada 15 s, e escrever no disco toda vez seria
 * ruído: o resultado é lembrado por `MEDIA_DIR_PROBE_TTL_MS`, então há no
 * máximo uma escrita por minuto, e a da inicialização já deixa o primeiro
 * resultado pronto.
 */

export type MediaDirProbe =
  | { dir: string; writable: true }
  | { dir: string; writable: false; code: string };

/** Sondagem real, sem cache: cria o diretório se faltar, escreve e apaga. */
export async function probeMediaDir(dir: string): Promise<MediaDirProbe> {
  const probe = path.join(dir, `.prueba-escritura-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "");
    await rm(probe, { force: true }).catch(() => {});
    return { dir, writable: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? String(err);
    return { dir, writable: false, code };
  }
}

/** Quanto vale uma sondagem antes de voltar a escrever. */
export const MEDIA_DIR_PROBE_TTL_MS = 60_000;

type ProbeCacheEntry = {
  dir: string;
  expiresAt: number;
  pending: Promise<MediaDirProbe>;
};

// Em globalThis, como o cliente de BD e o estado do cérebro externo: os
// módulos podem ser avaliados mais de uma vez (uma por rota em dev), e a sondagem
// da inicialização tem que servir ao /api/health.
const globalForMedia = globalThis as unknown as {
  __voceroMediaDirProbe?: ProbeCacheEntry;
};

/**
 * A sondagem com cache. Devolve `null` se o ambiente não valida: isso é
 * informado, com detalhe, pelo primeiro `getEnv()` do app, e aqui não há
 * diretório a sondar.
 *
 * O cache é por diretório: se `MEDIA_DIR` mudar, sondagem o novo
 * mesmo que o anterior esteja fresco.
 */
export async function mediaDirStatus(
  now: number = Date.now()
): Promise<MediaDirProbe | null> {
  let dir: string;
  try {
    dir = path.resolve(getEnv().MEDIA_DIR);
  } catch {
    return null;
  }
  const cached = globalForMedia.__voceroMediaDirProbe;
  if (cached && cached.dir === dir && cached.expiresAt > now) {
    return cached.pending;
  }
  const pending = probeMediaDir(dir);
  globalForMedia.__voceroMediaDirProbe = {
    dir,
    expiresAt: now + MEDIA_DIR_PROBE_TTL_MS,
    pending,
  };
  return pending;
}

/** Só para testes. */
export function resetMediaDirCache(): void {
  delete globalForMedia.__voceroMediaDirProbe;
}
