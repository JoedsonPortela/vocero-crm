import { rm } from "node:fs/promises";
import { apiError, withAuth } from "@/lib/api";
import {
  FAVICON_ASSET,
  MAX_FAVICON_BYTES,
  sniffFaviconMime,
} from "@/lib/favicon";
import { getBranding, saveBranding } from "@/server/branding";
import { mediaFilePath, saveMediaFile } from "@/server/whatsapp/media";

export const dynamic = "force-dynamic";

/**
 * Envia o ícone da aba. O corpo vai cru com o seu `content-type`, sem
 * multipart: é um arquivo avulso, e montar um parser de formulário para isso
 * é trabalho que não traz nenhum benefício.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Somente o proprietário pode alterar a marca");
  }

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0) {
    return apiError(422, "empty", "Nenhum arquivo foi recebido");
  }
  if (buf.byteLength > MAX_FAVICON_BYTES) {
    return apiError(
      413,
      "too_large",
      `El icono no puede pasar de ${Math.round(MAX_FAVICON_BYTES / 1024)} KB`
    );
  }

  // O tipo sai dos BYTES, não do que o cliente declarar: dizer
  // `image/png` e enviar um HTML é a forma clássica de passar um documento
  // onde se espera uma imagem, e isto é servido do mesmo domínio.
  const mime = sniffFaviconMime(buf);
  if (!mime) {
    return apiError(
      422,
      "unsupported",
      "Formato não reconhecido. Use PNG, SVG, ICO, JPEG ou WebP."
    );
  }

  await saveMediaFile(session.organizationId, FAVICON_ASSET, buf);

  const branding = await getBranding(session.organizationId);
  // Carimbo de tempo e não um contador: ao remover o ícone, não fica onde
  // guardar qual foi o último, então um contador reiniciaria em 1 e a URL
  // `?v=u1` seria a MESMA da logo anterior — o navegador continuaria
  // mostrando o antigo, que é justamente o que este número existe para evitar.
  const version = Date.now();
  await saveBranding(session.organizationId, {
    ...branding,
    favicon: { mime, version },
  });

  return Response.json({ favicon: { mime, version } });
});

/** Remove o enviado e volta ao gerado da marca. */
export const DELETE = withAuth(async (session) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Somente o proprietário pode alterar a marca");
  }

  const branding = await getBranding(session.organizationId);
  await saveBranding(session.organizationId, { ...branding, favicon: null });
  // O arquivo é apagado DEPOIS que a marca já não o referencia: se isto
  // falhar, fica um arquivo órfão — inofensivo — em vez de uma marca
  // apontando para algo que não existe mais.
  await rm(mediaFilePath(session.organizationId, FAVICON_ASSET), {
    force: true,
  }).catch(() => null);

  return Response.json({ favicon: null });
});
