import { readMediaFile } from "@/server/whatsapp/media";
import { getBrandingContext } from "@/server/branding";
import { DEFAULT_BRANDING } from "@/lib/branding";
import { FAVICON_ASSET, generatedFaviconSvg } from "@/lib/favicon";

export const dynamic = "force-dynamic";

/**
 * Cabeçalhos com os quais se serve QUALQUER ícone, enviado ou gerado.
 *
 * Um SVG que o dono envia é um documento com permissão de executar scripts se
 * alguém navega até a sua URL. A CSP não deixa nada para executar e `nosniff`
 * impede que o navegador reinterprete o tipo. São dois cabeçalhos e eliminam
 * toda essa classe de problema.
 */
function cabeceras(mime: string, cacheable: boolean): HeadersInit {
  return {
    "content-type": mime,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    // A URL leva `?v=` e muda com a marca, então pode ser cacheada
    // com força. Sem esse sufixo — alguém pedindo a rota pura — não.
    "cache-control": cacheable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60",
  };
}

/**
 * O ícone da aba. **Rota pública**: o login também tem aba, e
 * ali ainda não há sessão. É a mesma decisão que já toma o GET da
 * marca — em uma instância de um único negócio, o nome e o logo não são um
 * segredo.
 */
export async function GET(req: Request) {
  const cacheable = new URL(req.url).searchParams.has("v");

  const ctx = await getBrandingContext().catch(() => null);
  const branding = ctx?.branding ?? DEFAULT_BRANDING;

  if (ctx?.organizationId && branding.favicon) {
    try {
      const buf = await readMediaFile(ctx.organizationId, FAVICON_ASSET);
      return new Response(new Uint8Array(buf), {
        headers: cabeceras(branding.favicon.mime, cacheable),
      });
    } catch {
      // O arquivo se perdeu (volume não montado, restauração pela metade). Cai
      // no gerado em vez de deixar a aba sem ícone: um 404 aqui parece
      // que a instância está quebrada.
    }
  }

  return new Response(generatedFaviconSvg(branding), {
    headers: cabeceras("image/svg+xml", cacheable),
  });
}
