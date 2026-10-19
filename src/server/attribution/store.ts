import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { AnuncioDto } from "@/lib/types";
import { descargaEnCurso, guardarCreativo } from "@/server/attribution/creativo";
import { atribucionEnabled } from "@/server/attribution/flag";
import {
  anuncioDeWhatsapp,
  sinIdentificadorDeClic,
  type AnuncioDeOrigen,
} from "@/server/attribution/referral";

/**
 * 016 + 018 — De qual anúncio veio uma conversa.
 *
 * O `referral` só chega quando a mensagem vem de um anúncio
 * Click-to-WhatsApp, e normalmente só na PRIMEIRA mensagem da
 * conversa. Desde a 018 é guardado sempre, para que a caixa de entrada diga de qual
 * anúncio chegou cada pessoa; seu `ctwa_clid` —a chave para reportar à Meta
 * (016)— só com a bandeira `ATRIBUCION` ligada.
 */

/**
 * O que de fato é guardado de um anúncio. Sem a bandeira, sem identificador
 * de clique (018, D2). À parte e puro para poder testar as duas posições.
 */
export function anuncioParaGuardar(
  anuncio: AnuncioDeOrigen,
  atribuye: boolean = atribucionEnabled()
): AnuncioDeOrigen {
  return atribuye ? anuncio : sinIdentificadorDeClic(anuncio);
}

/**
 * O primeiro anúncio vence. `ON CONFLICT DO NOTHING` sobre o UNIQUE de
 * (organização, conversa) —e não um "consulta e depois insere"— porque a Meta
 * reenvia o webhook e duas entregas simultâneas venceriam a corrida as duas
 * (Constituição IV).
 */
export async function registrarAnuncioDeOrigen(input: {
  organizationId: string;
  contactId: string;
  conversationId: string;
  anuncio: AnuncioDeOrigen;
}): Promise<void> {
  const db = getDb();
  const a = anuncioParaGuardar(input.anuncio);
  const creadas = await db
    .insert(schema.adAttribution)
    .values({
      id: newId("adAttribution"),
      organizationId: input.organizationId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      ctwaClid: a.ctwaClid,
      sourceId: a.sourceId,
      sourceType: a.sourceType,
      sourceUrl: a.sourceUrl,
      headline: a.headline,
      body: a.body,
      mediaType: a.mediaType,
      raw: a.raw,
    })
    .onConflictDoNothing({
      target: [
        schema.adAttribution.organizationId,
        schema.adAttribution.conversationId,
      ],
    })
    .returning({ id: schema.adAttribution.id });

  // Só a linha nova baixa imagem: um reenvio não dispara outro download.
  if (creadas[0] && a.sourceId && a.imageUrl) {
    const { organizationId, conversationId } = input;
    const sourceId = a.sourceId;
    const imageUrl = a.imageUrl;
    void guardarCreativo({ organizationId, conversationId, sourceId, imageUrl }).catch(
      (err) =>
        console.warn(
          `[atribucion] imagen del anuncio ${sourceId} no guardada:`,
          err instanceof Error ? err.message : err
        )
    );
  }
}

/** Usada pela Conversions API (016): o anúncio de UMA conversa. */
export async function getAttributionForConversation(
  organizationId: string,
  conversationId: string
) {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.adAttribution)
    .where(
      and(
        eq(schema.adAttribution.organizationId, organizationId),
        eq(schema.adAttribution.conversationId, conversationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** A linha do anúncio de origem de um contato: o primeiro que o trouxe. */
async function primeraFilaDelContacto(organizationId: string, contactId: string) {
  const db = getDb();
  const filas = await db
    .select()
    .from(schema.adAttribution)
    .where(
      scoped(
        schema.adAttribution.organizationId,
        organizationId,
        eq(schema.adAttribution.contactId, contactId)
      )
    )
    .orderBy(asc(schema.adAttribution.createdAt), asc(schema.adAttribution.id))
    .limit(1);
  return filas[0] ?? null;
}

export async function anuncioDelContacto(
  organizationId: string,
  contactId: string
): Promise<AnuncioDto | null> {
  const fila = await primeraFilaDelContacto(organizationId, contactId);
  return fila ? serializarAnuncio(fila) : null;
}

/** No máximo uma tentativa de reparo por anúncio nesta janela. */
export const REPARAR_CADA_MS = 10 * 60_000;

/**
 * O freio do reparo, à parte para poder testá-lo sem base: cabe tentar esta
 * chave agora? Se sim, anota a tentativa. As chaves antigas
 * são purgadas para que o mapa não cresça sem fim.
 */
export function crearFreno(ventanaMs = REPARAR_CADA_MS, maxClaves = 5_000) {
  const ultimos = new Map<string, number>();
  return {
    intentar(clave: string, ahora = Date.now()): boolean {
      const anterior = ultimos.get(clave);
      if (anterior !== undefined && ahora - anterior < ventanaMs) return false;
      ultimos.set(clave, ahora);
      if (ultimos.size > maxClaves) {
        for (const [k, t] of ultimos) {
          if (ahora - t >= ventanaMs) ultimos.delete(k);
        }
      }
      return true;
    },
    get claves() {
      return ultimos.size;
    },
  };
}

const frenoDeReparacion = crearFreno();

/**
 * Se a imagem não pôde ser copiada na chegada (a rede tropeçou mais de uma vez, ou
 * a linha é de antes da 018), tenta-se de novo quando alguém abre o
 * contato: a URL da Meta costuma continuar viva alguns dias, e é justamente quando o
 * cartão vai ser visto.
 *
 * Não bloqueia a leitura, e vai com freio: o painel pede o detalhe a cada
 * evento da caixa de entrada, e sem ele uma URL que já não funciona seria pedida à Meta
 * uma e outra vez.
 */
export function repararImagenSiFalta(organizationId: string, contactId: string): void {
  void (async () => {
    const fila = await primeraFilaDelContacto(organizationId, contactId);
    if (!fila || fila.imageAssetId || !fila.sourceId) return;
    // A cópia da chegada continua em andamento: não é uma falha, e gastar aqui a
    // tentativa da janela deixaria sem reparo o que de fato falhe.
    if (descargaEnCurso(organizationId, fila.sourceId)) return;
    if (!frenoDeReparacion.intentar(`${organizationId}:${fila.sourceId}`)) return;

    // O `raw` mantém as chaves de imagem (também as das linhas da 016).
    const anuncio = anuncioDeWhatsapp(fila.raw);
    if (!anuncio?.imageUrl) return;
    await guardarCreativo({
      organizationId,
      conversationId: fila.conversationId,
      sourceId: fila.sourceId,
      imageUrl: anuncio.imageUrl,
    });
  })().catch((err) =>
    console.warn(
      `[atribucion] reparación de imagen del contacto ${contactId} falló:`,
      err instanceof Error ? err.message : err
    )
  );
}

/**
 * O que a caixa de entrada vê. O `ctwa_clid` NÃO viaja: é o identificador do clique
 * para a Conversions API, e quem atende só precisa saber se ele existe. E
 * nem isso sem a bandeira: «a Meta identificou o clique» só faz sentido numa
 * instância que atribui (018, D2), mesmo que a linha seja de quando ela o fazia.
 */
export function serializarAnuncio(
  fila: typeof schema.adAttribution.$inferSelect,
  atribuye: boolean = atribucionEnabled()
): AnuncioDto {
  return {
    sourceId: fila.sourceId,
    sourceType: fila.sourceType,
    // O link vai para um `href`: só https, mesmo que a ingestão já tenha filtrado.
    sourceUrl: fila.sourceUrl?.startsWith("https://") ? fila.sourceUrl : null,
    headline: fila.headline,
    body: fila.body,
    mediaType: fila.mediaType,
    imageAssetId: fila.imageAssetId,
    hasCtwaClid: atribuye && fila.ctwaClid !== null,
    capturedAt: fila.createdAt.toISOString(),
  };
}
