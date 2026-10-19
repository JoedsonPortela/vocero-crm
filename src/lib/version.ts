/**
 * Qual versão está rodando.
 *
 * Existe para responder a uma pergunta que hoje não tem resposta pelo app:
 * "já foi implantada a minha mudança?". Sem isso é preciso ir ao servidor comparar
 * commits, e na prática ninguém faz isso — assume-se que sim, e depura-se
 * por meia hora um bug que já estava corrigido num build que nunca
 * chegou.
 *
 * O que é congelado na CONSTRUÇÃO (ver `next.config.ts`) fica dentro do binário
 * e não muda em tempo de execução: a versão de `package.json` sempre, e
 * o commit SOMENTE se chegou ao build (build arg `SOURCE_COMMIT`).
 *
 * Se não chegou, o servidor mostra o `SOURCE_COMMIT` que encontrar no
 * ambiente na inicialização — mas esse é a palavra da plataforma, não do
 * código, e pode estar defasado: uma variável escrita à mão uma vez fica
 * parada enquanto o app continua sendo atualizado por baixo (#50). Por isso
 * viaja marcado como NÃO verificado, no selo e em `/api/health`, em vez
 * de se apresentar como se saísse do build.
 */

/** SemVer do `package.json`. Muda quando alguém publica, não a cada push. */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

/**
 * Commit do qual saiu o build, curto. Vazio se quem construiu não o passou
 * como build arg (`--build-arg SOURCE_COMMIT=...`).
 *
 * É o que de fato encerra a dúvida: dois deploys seguidos de `main` sem
 * mexer na versão aparecem idênticos pelo SemVer e diferentes pelo commit.
 */
export const BUILD_COMMIT = (process.env.NEXT_PUBLIC_BUILD_COMMIT ?? "").slice(0, 7);

export type ResolvedCommit = {
  /** Commit curto; vazio se não houver nenhum em lugar nenhum. */
  commit: string;
  /**
   * `true` SOMENTE se saiu do build. O que a plataforma anuncia em tempo de
   * execução não é: o binário não tem como verificar que esse commit seja
   * o do seu próprio código.
   */
  verified: boolean;
};

/**
 * Commit resolvido NO SERVIDOR, com a sua procedência.
 *
 * Primeiro o que foi congelado ao construir. Se quem construiu não o passou, o
 * `SOURCE_COMMIT` do ambiente: há plataformas que o publicam no
 * contêiner sem passá-lo ao build, e sem este respaldo o selo mostraria
 * apenas a versão — que não se move entre deploys da mesma release. Mas
 * esse respaldo sai como NÃO verificado: se a plataforma não o atualiza em
 * cada deploy, diz um commit que não é (#50).
 *
 * Só faz sentido chamá-la a partir do servidor: no cliente, `process.env`
 * traz apenas as variáveis `NEXT_PUBLIC_`.
 */
export function resolveCommit(): ResolvedCommit {
  if (BUILD_COMMIT) return { commit: BUILD_COMMIT, verified: true };
  return {
    commit: (process.env.SOURCE_COMMIT ?? "").trim().slice(0, 7),
    verified: false,
  };
}

/**
 * `v1.1.0 · 8e62d0b`, ou só `v1.1.0` se não houver commit em lugar nenhum.
 * O `commit` é passado quando o servidor o resolveu.
 */
export function versionLabel(commit: string = BUILD_COMMIT): string {
  return commit ? `v${APP_VERSION} · ${commit}` : `v${APP_VERSION}`;
}

/** O que acompanha, no selo, um commit que não saiu do build. */
export const UNVERIFIED_COMMIT_NOTE = "commit sin verificar";

/**
 * O tooltip do selo. O nome vem da marca e não de uma constante: isto é
 * white-label, e uma instância renomeada que diz "Vocero" aqui denuncia o
 * produto de baixo.
 *
 * Com um commit não verificado diz de onde saiu e como corrigir: quem o lê
 * está justamente em dúvida sobre qual código roda.
 */
export function versionTitle(name: string, resolved: ResolvedCommit): string {
  if (!resolved.commit) return `${name} ${APP_VERSION}`;
  if (resolved.verified) {
    return `${name} ${APP_VERSION}, construido del commit ${resolved.commit}`;
  }
  return (
    `${name} ${APP_VERSION}. El commit ${resolved.commit} no viene del build: ` +
    "lo anunció la plataforma al arrancar y puede no ser el del código que " +
    "corre. Para verificarlo, pásalo como build arg SOURCE_COMMIT en cada despliegue."
  );
}
