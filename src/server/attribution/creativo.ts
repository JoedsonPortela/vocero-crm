import { eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { isMockEnabled } from "@/lib/env";
import { publish } from "@/server/events/bus";
import { deleteMediaFile, saveMediaFile } from "@/server/whatsapp/media";

/**
 * 018 — A imagem do criativo, copiada na chegada.
 *
 * A URL que a Meta envia no `referral` expira em dias (o parâmetro `oe` do
 * seu CDN). Se não for copiada nesse momento, o cartão do anúncio fica sem
 * imagem para sempre. Ela é guardada como um anexo a mais — mesmo volume, mesma
 * rota com sessão — e UMA vez por anúncio.
 *
 * Tudo aqui é best-effort e roda fora do caminho do webhook: a mensagem do
 * cliente já está na caixa de entrada quando isto começa, e nada do que falhe
 * aqui pode afetá-la.
 */

/** O jpg de um criativo fica em torno de 20-150 KB; acima disso não é uma miniatura. */
export const CREATIVO_MAX_BYTES = 300_000;
/** Tempo por tentativa, contando redirecionamentos e a leitura do corpo. */
const TIEMPO_MS = 5_000;
const MAX_REDIRECCIONES = 3;
/** Espera antes da única nova tentativa: o suficiente para um tropeço de rede. */
const REINTENTO_MS = 1_500;

/** Sem SVG: servido a partir da nossa origem, um SVG pode executar scripts. */
const TIPOS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Domínios dos quais a Meta serve os criativos. A URL chega dentro de um
 * payload externo: sem esta lista, a ingestão baixaria qualquer URL que
 * alguém escrever, inclusive a rede interna do servidor (SSRF).
 */
const DOMINIOS_DE_META = [
  "fbcdn.net",
  "fbsbx.com",
  "facebook.com",
  "cdninstagram.com",
  "instagram.com",
];

function esDeMeta(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return DOMINIOS_DE_META.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Esta URL pode ser baixada? Pura para poder testá-la.
 *
 * `origenMock` é a origem do wa-mock e só é passado com os mocks
 * habilitados, que em produção não existem (`isMockEnabled` exige
 * `NODE_ENV !== "production"`).
 */
export function urlDeCreativoPermitida(
  raw: string,
  origenMock: string | null = null
): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (origenMock && u.origin === origenMock) return true;
  if (u.protocol !== "https:") return false;
  // A Meta serve seus CDNs pela 443: uma porta explícita não é da Meta.
  if (u.port !== "") return false;
  return esDeMeta(u.hostname);
}

function origenDelMock(): string | null {
  if (!isMockEnabled()) return null;
  const base = process.env.META_GRAPH_BASE_URL;
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/**
 * Como terminou um download. `transitoria` vale a pena tentar de novo (a rede, um
 * 5xx, um 429, o tempo); `permanente` não vai mudar por insistir (host não
 * permitido, não é imagem, grande demais, 404).
 */
export type Descarga =
  | { ok: true; data: Buffer; mimeType: string }
  | { ok: false; falla: "transitoria" | "permanente" };

const PERMANENTE = { ok: false, falla: "permanente" } as const;
const TRANSITORIA = { ok: false, falla: "transitoria" } as const;

/** Descarta o corpo que não será lido: senão a conexão fica ocupada. */
function descartar(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

/**
 * Lê o corpo com limite: corta-se assim que passa de `max`, em vez de carregar na
 * memória o que um servidor queira enviar sem `content-length`.
 */
async function leerConTope(
  res: Response,
  max: number
): Promise<Buffer | "grande" | "cortado"> {
  if (!res.body) return Buffer.alloc(0);
  const lector = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void lector.cancel().catch(() => {});
        return "grande";
      }
      partes.push(value);
    }
  } catch {
    return "cortado"; // tempo esgotado ou conexão caída no meio da leitura
  }
  return Buffer.concat(partes);
}

/**
 * Download limitado: cada salto de redirecionamento é validado de novo, então um
 * host da Meta não pode mandar a requisição para outro site.
 */
export async function descargarCreativo(url: string): Promise<Descarga> {
  const origenMock = origenDelMock();
  const signal = AbortSignal.timeout(TIEMPO_MS);
  let actual = url;
  for (let salto = 0; salto <= MAX_REDIRECCIONES; salto++) {
    if (!urlDeCreativoPermitida(actual, origenMock)) return PERMANENTE;
    let res: Response;
    try {
      res = await fetch(actual, {
        redirect: "manual",
        signal,
        cache: "no-store",
        headers: { accept: "image/*" },
      });
    } catch {
      return TRANSITORIA; // tempo esgotado ou rede caída
    }
    if (res.status >= 300 && res.status < 400) {
      const destino = res.headers.get("location");
      descartar(res);
      if (!destino) return PERMANENTE;
      try {
        actual = new URL(destino, actual).toString();
      } catch {
        return PERMANENTE;
      }
      continue;
    }
    if (res.status >= 500 || res.status === 429) {
      descartar(res);
      return TRANSITORIA;
    }
    if (!res.ok) {
      descartar(res);
      return PERMANENTE;
    }

    const mimeType =
      res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const declarado = Number(res.headers.get("content-length") ?? "0");
    if (!TIPOS[mimeType] || declarado > CREATIVO_MAX_BYTES) {
      descartar(res);
      return PERMANENTE;
    }

    const data = await leerConTope(res, CREATIVO_MAX_BYTES);
    if (data === "cortado") return TRANSITORIA;
    if (data === "grande" || data.byteLength === 0) return PERMANENTE;
    return { ok: true, data, mimeType };
  }
  return PERMANENTE; // redirecionamentos demais
}

/** Download com uma nova tentativa se a falha foi transitória. */
export async function descargarConReintento(
  url: string,
  esperaMs = REINTENTO_MS
): Promise<Descarga> {
  const primera = await descargarCreativo(url);
  if (primera.ok || primera.falla === "permanente") return primera;
  await new Promise((r) => setTimeout(r, esperaMs));
  return descargarCreativo(url);
}

/** A imagem já guardada deste anúncio, se outra conversa a trouxe. */
async function imagenExistente(
  organizationId: string,
  sourceId: string
): Promise<string | null> {
  const db = getDb();
  const filas = await db
    .select({ assetId: schema.mediaAsset.id })
    .from(schema.adAttribution)
    .innerJoin(
      schema.mediaAsset,
      eq(schema.mediaAsset.id, schema.adAttribution.imageAssetId)
    )
    .where(
      scoped(
        schema.adAttribution.organizationId,
        organizationId,
        eq(schema.adAttribution.sourceId, sourceId),
        eq(schema.mediaAsset.organizationId, organizationId),
        eq(schema.mediaAsset.fetchStatus, "available")
      )
    )
    .limit(1);
  return filas[0]?.assetId ?? null;
}

/**
 * Deixa a imagem em todas as conversas do anúncio que ainda não a têm:
 * o download que trouxe a primeira serve também às que chegaram enquanto
 * isso acontecia.
 */
async function asignarImagen(
  organizationId: string,
  sourceId: string,
  assetId: string
): Promise<number> {
  const db = getDb();
  const filas = await db
    .update(schema.adAttribution)
    .set({ imageAssetId: assetId })
    .where(
      scoped(
        schema.adAttribution.organizationId,
        organizationId,
        eq(schema.adAttribution.sourceId, sourceId),
        isNull(schema.adAttribution.imageAssetId)
      )
    )
    .returning({ id: schema.adAttribution.id });
  return filas.length;
}

/**
 * Downloads em andamento por anúncio. O caso normal os junta: entra a primeira
 * mensagem, dispara-se a cópia, e o painel aberto pede o detalhe naquele mesmo
 * instante e dispararia o reparo. Sem isso seriam dois downloads e um
 * anexo a mais.
 */
const enCurso = new Set<string>();

/** Já existe uma cópia em andamento para este anúncio? */
export function descargaEnCurso(organizationId: string, sourceId: string): boolean {
  return enCurso.has(`${organizationId}:${sourceId}`);
}

export async function guardarCreativo(input: {
  organizationId: string;
  conversationId: string;
  sourceId: string;
  imageUrl: string;
}): Promise<string | null> {
  const { organizationId, sourceId } = input;
  // O cartão aberto é atualizado com este evento: a imagem aparece sozinha.
  const avisar = () =>
    publish(organizationId, {
      type: "conversation.updated",
      data: { conversation: { id: input.conversationId } },
    });

  const existente = await imagenExistente(organizationId, sourceId);
  if (existente) {
    await asignarImagen(organizationId, sourceId, existente);
    avisar();
    return existente;
  }

  const clave = `${organizationId}:${sourceId}`;
  if (enCurso.has(clave)) return null;
  enCurso.add(clave);
  try {
    return await descargarYGuardar(input, avisar);
  } finally {
    enCurso.delete(clave);
  }
}

async function descargarYGuardar(
  input: { organizationId: string; sourceId: string; imageUrl: string },
  avisar: () => void
): Promise<string | null> {
  const { organizationId, sourceId } = input;

  const descarga = await descargarConReintento(input.imageUrl);
  if (!descarga.ok) {
    console.warn(
      `[atribucion] la imagen del anuncio ${sourceId} no se copió (${descarga.falla})`
    );
    return null;
  }

  const db = getDb();
  const assetId = newId("mediaAsset");
  const extension = TIPOS[descarga.mimeType] ?? "jpg";
  let guardado = false;
  try {
    await db.insert(schema.mediaAsset).values({
      id: assetId,
      organizationId,
      kind: "image",
      mimeType: descarga.mimeType,
      fileName: `anuncio-${sourceId.replace(/[^\w.-]/g, "_").slice(0, 64)}.${extension}`,
      payload: { origen: "anuncio", sourceId },
      fetchStatus: "pending",
    });
    const storagePath = await saveMediaFile(organizationId, assetId, descarga.data);
    guardado = true;
    await db
      .update(schema.mediaAsset)
      .set({
        storagePath,
        fileSize: descarga.data.byteLength,
        fetchStatus: "available",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAsset.id, assetId));
    if ((await asignarImagen(organizationId, sourceId, assetId)) === 0) {
      // Outro download (outro processo, ou um que começou antes) já deixou sua
      // imagem: esta cópia sobra e não deve ficar ocupando o volume.
      await deleteMediaFile(organizationId, assetId).catch(() => {});
      await db.delete(schema.mediaAsset).where(eq(schema.mediaAsset.id, assetId));
      return imagenExistente(organizationId, sourceId);
    }
  } catch (err) {
    // Remove-se o que foi possível criar; se já estava atribuído, a chave
    // estrangeira deixa essas linhas sem imagem (`set null`), não apontando para nada.
    if (guardado) await deleteMediaFile(organizationId, assetId).catch(() => {});
    await db
      .delete(schema.mediaAsset)
      .where(eq(schema.mediaAsset.id, assetId))
      .catch(() => {});
    console.warn(
      `[atribucion] no se pudo guardar la imagen del anuncio ${sourceId}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  avisar();
  return assetId;
}
