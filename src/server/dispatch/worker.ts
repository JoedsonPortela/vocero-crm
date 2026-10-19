import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { leerConfigDespacho } from "@/server/brains/config";
import {
  construirEvento,
  entregar,
  rafagaDe,
  sinDespachar,
} from "@/server/brains/deliver";
import {
  caducarAHumano,
  descartarDespacho,
  encolarDespacho,
  marcarEntregado,
  mensajesAnotados,
  pasarAHumano,
  reintentarOCaducar,
  renovarLease,
  tomarPendientes,
  type FilaDespacho,
} from "@/server/dispatch/outbox";

/**
 * 021 — O worker do despachante.
 *
 * Dentro do processo, como o resto do trabalho de fundo do repositório (sem filas
 * externas: constituição II). O que o torna confiável não é o processo, mas o
 * outbox: se morrer no meio, o lease expira e o próximo varrimento o retoma;
 * se o contêiner reiniciar, os pendentes continuam ali e a inicialização os
 * retoma (`instrumentation-node.ts`).
 *
 * Adaptação de `src/server/dispatch/worker.ts` do Vocero Cloud.
 */

/**
 * O varrimento de fundo. Não é o que dispara o caso normal — para isso existe
 * `programarTanda` —, mas a rede: linhas em espera após uma falha, as que
 * enfileirou outro processo e as que ficaram de antes de um reinício.
 */
const INTERVALO_MS = 2000;
const POR_TANDA = 10;
/**
 * Margem sobre a hora agendada. `tomarPendientes` filtra por
 * `not_before <= agora`: acordar grudado na borda pode chegar um
 * milissegundo antes, não ver a linha e deixá-la para o varrimento.
 */
const MARGEN_MS = 50;
/** De quanto em quanto tempo se renova o lease enquanto se espera pelo cérebro. */
const LATIDO_MS = 20_000;

type Estado = {
  timer: NodeJS.Timeout | null;
  corriendo: boolean;
  // O próximo agendamento e a sua hora. Guarda-se a hora para não sobrescrever um
  // agendamento mais próximo com outro mais distante: enfileirar em duas conversas ao
  // mesmo tempo deixaria a primeira esperando a segunda.
  cita: NodeJS.Timeout | null;
  citaEn: number | null;
};

// Em globalThis porque em dev os módulos são avaliados mais de uma vez (uma por
// rota) e todas as cópias devem compartilhar o mesmo worker: dois temporizadores
// sobre o mesmo outbox se atropelariam no lease.
const globalForWorker = globalThis as unknown as {
  __voceroDispatchWorker?: Estado;
};

function estado(): Estado {
  if (!globalForWorker.__voceroDispatchWorker) {
    globalForWorker.__voceroDispatchWorker = {
      timer: null,
      corriendo: false,
      cita: null,
      citaEn: null,
    };
  }
  return globalForWorker.__voceroDispatchWorker;
}

export function iniciarWorker(): void {
  const e = estado();
  if (e.timer) return;
  e.timer = setInterval(() => void tanda(), INTERVALO_MS);
  // `unref` para que o temporizador não impeça o processo de terminar.
  e.timer.unref?.();
}

/**
 * Acorda o worker quando vencer esta janela, além do varrimento.
 *
 * A janela de agrupamento existe por uma razão (as pessoas escrevem aos pedaços),
 * mas os até 2 s depois eram só o worker sem perceber.
 *
 * Um só agendamento, o mais próximo. As demais linhas que vencerem nesse meio-tempo as
 * recolhe esse mesmo lote, porque pega TODAS as vencidas, não só a sua.
 */
export function programarTanda(cuando: Date): void {
  const e = estado();
  const objetivo = cuando.getTime() + MARGEN_MS;
  if (e.citaEn !== null && e.citaEn <= objetivo) return;
  if (e.cita) clearTimeout(e.cita);
  e.citaEn = objetivo;
  e.cita = setTimeout(() => {
    e.cita = null;
    e.citaEn = null;
    void tanda();
  }, Math.max(0, objetivo - Date.now()));
  e.cita.unref?.();
}

export function detenerWorker(): void {
  const e = estado();
  if (e.timer) clearInterval(e.timer);
  e.timer = null;
  if (e.cita) clearTimeout(e.cita);
  e.cita = null;
  e.citaEn = null;
}

/** Uma passada. Devolve quantos despachos pegou. */
export async function tanda(ahora: Date = new Date()): Promise<number> {
  const e = estado();
  if (e.corriendo) return 0;
  e.corriendo = true;
  try {
    let count = 0;
    for (; count < POR_TANDA; count++) {
      // Um por um, e com a hora de AGORA: as que esperam na fila não
      // envelhecem atrás de um POST lento com o lease já correndo.
      const [fila] = await tomarPendientes(1, count === 0 ? ahora : new Date());
      if (!fila) break;
      const latido = setInterval(() => {
        void renovarLease(fila).catch(() =>
          console.error("[despacho] no se pudo renovar el lease")
        );
      }, LATIDO_MS);
      latido.unref?.();
      try {
        await procesar(fila);
      } finally {
        clearInterval(latido);
      }
    }
    return count;
  } catch (err) {
    console.error("[despacho] la tanda falló:", err);
    return 0;
  } finally {
    e.corriendo = false;
  }
}

async function procesar(fila: FilaDespacho): Promise<void> {
  const config = leerConfigDespacho();
  if (!config.active) {
    // Ficou de antes de a configuração ser removida ou quebrada: já não
    // há a quem entregá-lo, e o agente incluído volta a ser quem manda.
    await descartarDespacho(fila, "el despacho ya no está configurado");
    return;
  }

  /**
   * A pausa é conferida de novo ao ENTREGAR, não só ao enfileirar.
   *
   * Entre um momento e outro existe a janela de agrupamento: se alguém pausar a
   * IA nesses segundos, o turno já não corresponde a nenhum cérebro.
   */
  const [conv] = await getDb()
    .select({
      aiEnabled: schema.conversation.aiEnabled,
      handoffAt: schema.conversation.handoffAt,
      isTest: schema.conversation.isTest,
    })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.id, fila.conversationId),
        eq(schema.conversation.organizationId, fila.organizationId)
      )
    )
    .limit(1);
  if (!conv) {
    await descartarDespacho(fila, "la conversación ya no existe");
    return;
  }
  if (!conv.aiEnabled || conv.handoffAt || conv.isTest) {
    await descartarDespacho(fila, "la IA se pausó antes de despachar");
    return;
  }

  const evento = await construirEvento(fila);
  if (!evento) {
    await descartarDespacho(fila, "la conversación ya no existe");
    return;
  }
  /**
   * 025 — Um despacho sem mensagens não é entregue.
   *
   * Acontece quando o que o provocou já foi respondido por uma pessoa dentro da
   * janela. Não é uma queda do cérebro: enviá-lo vazio seria pedir a ele um
   * turno sobre nada —a Nea o rejeita com 422—, e um 4xx não é reintentado: a
   * conversa acabaria com um humano por uma falha que não existiu.
   */
  if (evento.messages.length === 0) {
    await descartarDespacho(fila, "sin mensajes por despachar");
    return;
  }

  const resultado = await entregar(evento, config);
  // O lease pode ter vencido enquanto se esperava pelo cérebro, e outro pode ter retomado
  // a linha: se já não é nossa, o que fizermos aqui atropelaria o trabalho dele.
  if (!(await renovarLease(fila))) return;

  if (resultado.ok) {
    if (!(await marcarEntregado(fila))) return;
    /**
     * 025 — O que entrou enquanto o evento ia em voo não viajou nele.
     *
     * O evento foi montado antes de essa mensagem existir. `encolarDespacho`
     * a deixou anotada na linha, então aqui ela é relida: o anotado (e o que
     * houver na rajada) menos o que o cérebro recebeu é o que segue sendo
     * pendente, e sai em outro despacho com esses ids anotados.
     */
    const actual = await rafagaDe(
      fila.organizationId,
      fila.conversationId,
      await mensajesAnotados(fila)
    );
    const pendientes = sinDespachar(
      evento.messages.map((m) => m.id),
      actual
    );
    if (pendientes.length) {
      const { notBefore } = await encolarDespacho({
        organizationId: fila.organizationId,
        conversationId: fila.conversationId,
        messageIds: pendientes,
      });
      programarTanda(notBefore);
    }
    return;
  }

  console.error(
    `[despacho] ${fila.id} (intento ${fila.attempts}): ${resultado.detalle}`
  );
  const caduco = resultado.reintentable
    ? await reintentarOCaducar(fila, resultado.detalle)
    : await caducarAHumano(fila, resultado.detalle);
  if (caduco) await pasarAHumano(fila.organizationId, fila.conversationId);
}
