import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { mediaDirStatus } from "@/server/media-dir";
import { leerConfigDespacho } from "@/server/brains/config";
import { iniciarWorker, tanda } from "@/server/dispatch/worker";
import { cifrarSecretosEnClaro } from "@/server/zernio/secreto-guardado";

/**
 * 008 — Aviso na inicialização se MEDIA_DIR não for gravável. Sem isso, o primeiro
 * sintoma era um 500 ao enviar o logo ou o ícone, ou anexos recebidos "não
 * disponíveis" (são tentados de novo ao abri-los, mas só enquanto a Meta os
 * mantiver), com o EACCES enterrado no log de uma requisição. Testa-se
 * gravando de verdade (o mesmo que saveMediaFile fará) e nunca derruba a
 * inicialização: o resto do CRM funciona sem anexos.
 *
 * A verificação fica em `server/media-dir.ts` e é a mesma que `/api/health`
 * expõe como `mediaWritable` (#82): este resultado fica em cache e o
 * healthcheck o reutiliza em vez de gravar de novo.
 */
export async function checkMediaDir(): Promise<void> {
  const media = await mediaDirStatus();
  // Sem ambiente válido não há nada a verificar: quem informa, com detalhes, é o
  // primeiro getEnv() do app.
  if (!media || media.writable) return;
  console.error(
    `[boot] MEDIA_DIR=${media.dir} no es escribible (${media.code}): los adjuntos entrantes, el logo y el icono NO se van a poder guardar. ` +
      "En Docker: monta un volumen persistente en /data (la imagen ya usa /data/media) y arranca el contenedor como root —el default—, " +
      "que el entrypoint le da el volumen al usuario de la app. Fuera de Docker: apunta MEDIA_DIR a un directorio escribible."
  );
}

/**
 * Limpeza na inicialização (FR-034): execuções do Laboratório que ficaram
 * "running" após um reinício → falhas. Só roda no runtime Node.
 */
export async function cleanupOrphanRuns(): Promise<void> {
  try {
    const db = getDb();
    const updated = await db
      .update(schema.agentTestRun)
      .set({
        status: "failed",
        error: "Interrumpida por un reinicio del servidor",
        finishedAt: new Date(),
      })
      .where(eq(schema.agentTestRun.status, "running"))
      .returning({ id: schema.agentTestRun.id });
    if (updated.length > 0) {
      console.log(
        `[boot] ${updated.length} corrida(s) del Laboratorio huérfana(s) marcada(s) como fallida(s)`
      );
    }
  } catch (err) {
    // O BD pode ainda não estar pronto (as migrações rodam antes do servidor).
    console.error("[boot] limpieza de corridas huérfanas falló:", err);
  }
}

/**
 * 030 — Cifra os segredos de assinatura da Zernio que uma versão anterior gravou
 * em texto claro. Fica aqui e não em `migrate.mjs` porque cifrar exige a
 * `ENCRYPTION_KEY` validada e o mesmo `encryptSecret` do token, e porque
 * assim roda também com `next dev` (spec 030, D3). Nunca derruba a inicialização:
 * enquanto uma linha não estiver cifrada, seu segredo continua sendo lido (D5).
 */
export async function encryptLegacySecrets(): Promise<void> {
  try {
    const cifrados = await cifrarSecretosEnClaro();
    if (cifrados > 0) {
      console.log(`[boot] ${cifrados} secreto(s) de firma de Zernio cifrado(s) en reposo`);
    }
  } catch (err) {
    console.error(
      "[boot] no se pudieron cifrar los secretos de firma de Zernio guardados en claro; se reintenta en el próximo arranque:",
      err instanceof Error ? err.message : "error desconocido"
    );
  }
}

/**
 * 021 — Retoma o despacho ao iniciar. Sem isso, um turno que ficou
 * pendente ou em nova tentativa quando o contêiner reiniciou ficaria aguardando
 * que chegasse OUTRA mensagem para alguém ligar o worker.
 *
 * Só com o despacho ativo: uma instância sem cérebro não varre nada. E o que
 * estiver mal configurado é informado aqui uma vez, além do cartão «Quem
 * responde»: é o log que alguém olha quando o agente não responde.
 */
export function resumeDispatch(): void {
  const config = leerConfigDespacho();
  if (config.active) {
    iniciarWorker();
    void tanda();
    console.log(`[boot] despacho al cerebro activo → ${config.host}`);
    return;
  }
  if (config.problem === "url") {
    console.error(
      "[boot] BRAIN_DISPATCH_URL no es una URL http:// o https:// válida (sin usuario:clave): el despacho al cerebro queda INACTIVO."
    );
  } else if (config.problem === "sin_llave") {
    console.error(
      "[boot] BRAIN_DISPATCH_URL está definida pero falta BOT_API_KEY (mínimo 16 caracteres): el despacho al cerebro queda INACTIVO."
    );
  }
}
