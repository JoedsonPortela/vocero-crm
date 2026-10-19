import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { graphRequest, MetaApiError } from "@/lib/meta/client";
import {
  getCredentialsByOrg,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { isForbiddenUploadMime } from "@/server/whatsapp/media-headers";

/**
 * 008 — Única fronteira de mídia com a Graph API (constituição II: todo o
 * tráfego para a Meta passa por adaptadores dedicados) + persistência no volume
 * local `MEDIA_DIR`. A Meta expira seus arquivos (~30 dias, URLs de minutos):
 * o disco próprio é a cópia durável que a UI pré-visualiza.
 */

export type MediaKind = (typeof schema.mediaAsset.$inferSelect)["kind"];

/** Limites da Cloud API por tipo (validados ANTES de tocar a rede, FR-007). */
export const MEDIA_LIMITS: Record<
  Exclude<MediaKind, "location" | "contacts">,
  { maxBytes: number; mimes: RegExp; label: string }
> = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    mimes: /^image\/(jpeg|png|webp)$/,
    label: "imagen (jpeg/png/webp, máx. 5 MB)",
  },
  sticker: {
    maxBytes: 100 * 1024,
    mimes: /^image\/webp$/,
    label: "sticker (webp, máx. 100 KB)",
  },
  audio: {
    maxBytes: 16 * 1024 * 1024,
    mimes: /^audio\/(aac|mp4|mpeg|amr|ogg|opus)/,
    label: "audio (aac/mp4/mpeg/amr/ogg, máx. 16 MB)",
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    mimes: /^video\/(mp4|3gpp)$/,
    label: "video (mp4/3gpp, máx. 16 MB)",
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    mimes: /^[\w.-]+\/[\w.+-]+$/,
    label: "documento (máx. 100 MB)",
  },
};

/** Classifica um MIME de arquivo de saída no tipo de mensagem da Cloud API. */
export function kindFromMime(mime: string): "image" | "audio" | "video" | "document" {
  if (MEDIA_LIMITS.image.mimes.test(mime)) return "image";
  if (MEDIA_LIMITS.audio.mimes.test(mime)) return "audio";
  if (MEDIA_LIMITS.video.mimes.test(mime)) return "video";
  return "document";
}

export class MediaValidationError extends Error {
  code: "too_large" | "unsupported_type";
  constructor(code: MediaValidationError["code"], message: string) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

/**
 * Valida MIME e tamanho para envio; devolve o kind resolvido. Os formatos
 * que o WhatsApp não aceita como seu tipo nativo (p. ex. image/bmp) vão como
 * documento — igual faz o app do WhatsApp. HTML e SVG não vão nem como
 * documento (#78): o navegador de quem os abrisse os trataria como uma
 * página, e seriam servidos a partir da origem do CRM.
 */
export function validateOutgoing(mime: string, sizeBytes: number) {
  if (!/^[\w.-]+\/[\w.+-]+$/.test(mime)) {
    throw new MediaValidationError("unsupported_type", "Tipo de archivo no reconocido");
  }
  if (isForbiddenUploadMime(mime)) {
    throw new MediaValidationError(
      "unsupported_type",
      "Los archivos HTML y SVG no se pueden enviar como adjunto: un navegador los abriría como página. Conviértelo a PDF o a imagen"
    );
  }
  const kind = kindFromMime(mime);
  const limit = MEDIA_LIMITS[kind];
  if (sizeBytes > limit.maxBytes) {
    throw new MediaValidationError(
      "too_large",
      `El archivo excede el límite de ${limit.label}`
    );
  }
  return kind;
}

/* ---------- Disco local ---------- */

function assertSafeSegment(s: string): void {
  if (!/^[\w.-]+$/.test(s)) throw new Error(`segmento de ruta inválido: ${s}`);
}

/** Caminho absoluto do arquivo de um asset dentro de MEDIA_DIR. */
export function mediaFilePath(organizationId: string, assetId: string): string {
  assertSafeSegment(organizationId);
  assertSafeSegment(assetId);
  return path.join(getEnv().MEDIA_DIR, organizationId, assetId);
}

export async function saveMediaFile(
  organizationId: string,
  assetId: string,
  data: Buffer | Uint8Array
): Promise<string> {
  const file = mediaFilePath(organizationId, assetId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return path.join(organizationId, assetId); // ruta relativa persistida en BD
}

export async function readMediaFile(
  organizationId: string,
  assetId: string
): Promise<Buffer> {
  return readFile(mediaFilePath(organizationId, assetId));
}

/**
 * 018 — Apaga o arquivo de um asset. Sem erro se já não estava: quem o
 * chama está desfazendo uma cópia que sobrou, e um arquivo que não existe é
 * justamente o estado ao qual quer chegar.
 */
export async function deleteMediaFile(
  organizationId: string,
  assetId: string
): Promise<void> {
  await rm(mediaFilePath(organizationId, assetId), { force: true });
}

/* ---------- Download a partir do Graph (entrantes e echoes) ---------- */

type GraphMediaMeta = { url?: string; mime_type?: string; file_size?: number };

export class MediaFetchError extends Error {
  /** true se a Meta já não tiver o arquivo (expirado/apagado) — não tentar de novo. */
  gone: boolean;
  constructor(message: string, gone = false) {
    super(message);
    this.name = "MediaFetchError";
    this.gone = gone;
  }
}

/**
 * Baixa uma mídia do Graph: GET {mediaId} → url efêmera → GET com Bearer.
 * O token JAMAIS sai do servidor.
 */
export async function downloadGraphMedia(
  token: string,
  waMediaId: string,
  maxBytes: number = MEDIA_LIMITS.document.maxBytes
): Promise<{ data: Buffer; mimeType: string | null; fileSize: number }> {
  let meta: GraphMediaMeta;
  try {
    meta = await graphRequest<GraphMediaMeta>(waMediaId, { token });
  } catch (err) {
    const gone = err instanceof MetaApiError && err.status === 404;
    throw new MediaFetchError("Meta no entregó la metadata del adjunto", gone);
  }
  if (!meta.url) throw new MediaFetchError("Meta no entregó URL del adjunto");
  if (meta.file_size && meta.file_size > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }

  let res: Response;
  try {
    res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new MediaFetchError("No se pudo descargar el adjunto");
  }
  if (!res.ok) {
    throw new MediaFetchError(
      `La descarga devolvió ${res.status}`,
      res.status === 404 || res.status === 410
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
  return {
    data: buf,
    mimeType: meta.mime_type ?? res.headers.get("content-type"),
    fileSize: buf.byteLength,
  };
}

/**
 * Garante que o asset esteja no disco (`fetchStatus=available`).
 * Usa-se no download in-process pós-ingestão E sob demanda pela rota de
 * mídia. Nunca lança em direção ao webhook: quem chama decide o que fazer com o
 * resultado. Devolve o asset atualizado ou null se não foi possível.
 */
export async function ensureAssetAvailable(
  organizationId: string,
  assetId: string
): Promise<typeof schema.mediaAsset.$inferSelect | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mediaAsset)
    .where(eq(schema.mediaAsset.id, assetId))
    .limit(1);
  const asset = rows[0];
  if (!asset || asset.organizationId !== organizationId) return null;
  if (asset.fetchStatus === "available") return asset;
  if (!asset.waMediaId) return null; // location/contacts no tienen binario

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) return null;

  try {
    const { data, mimeType, fileSize } = await downloadGraphMedia(
      creds.token,
      asset.waMediaId
    );
    const storagePath = await saveMediaFile(organizationId, assetId, data);
    const updated = await db
      .update(schema.mediaAsset)
      .set({
        storagePath,
        mimeType: asset.mimeType ?? mimeType,
        fileSize,
        fetchStatus: "available",
        fetchError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAsset.id, assetId))
      .returning();
    return updated[0] ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.mediaAsset)
      .set({ fetchStatus: "failed", fetchError: message, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));
    console.warn(`[media] descarga del asset ${assetId} falló: ${message}`);
    return null;
  }
}

/* ---------- Envio ao Graph (saídas) ---------- */

/**
 * Envia um arquivo ao Graph (`POST /{phone_number_id}/media`, multipart) e
 * devolve o media id para usar em /messages. Erros → MetaApiError (a
 * camada de envio os traduz com as mesmas regras do texto).
 */
export async function uploadGraphMedia(
  credentials: Credentials,
  file: { data: Buffer | Uint8Array; mimeType: string; fileName?: string }
): Promise<string> {
  const env = getEnv();
  const url = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/media`;
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.mimeType);
  const bytes = new Uint8Array(file.data);
  form.set(
    "file",
    new Blob([bytes], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.token}` },
      body: form,
    });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Meta", {
      status: 0,
      details: cause,
    });
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } })
      ?.error;
    throw new MetaApiError(err?.message ?? `Meta respondió ${res.status}`, {
      status: res.status,
      code: err?.code ?? null,
      type: err?.type ?? null,
      details: json ?? text,
    });
  }
  const id = (json as { id?: string })?.id;
  if (!id) {
    throw new MetaApiError("Meta no devolvió ID del media subido", {
      status: res.status,
    });
  }
  return id;
}
