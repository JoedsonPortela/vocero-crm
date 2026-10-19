import { mockGuard } from "@/lib/dev-guard";
import { pngDePrueba } from "@/server/dev/png-de-prueba";

/**
 * Binário de teste do wa-mock (media proxy do bot). Os metadados do mock do
 * Graph apontam para cá como a "url" efêmera do anexo.
 *
 * 018 — Também serve os criativos dos anúncios simulados. Os ids que
 * começam com `creativo` devolvem um PNG real; alguns provocam de propósito
 * os caminhos que a cópia deve recusar ou tentar de novo.
 */
export const dynamic = "force-dynamic";

/** Quantas vezes cada criativo foi pedido, para simular falhas que se curam. */
const pedidos = new Map<string, number>();

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = mockGuard();
  if (guard) return guard;
  const { id } = await ctx.params;

  if (id.startsWith("creativo")) {
    if (id === "creativo-enorme") {
      // Maior que o limite de uma miniatura.
      return new Response(new Uint8Array(400_000), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (id === "creativo-svg") {
      // Um SVG servido da nossa origem poderia executar scripts.
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        headers: { "content-type": "image/svg+xml" },
      });
    }
    if (id === "creativo-redirige") {
      // Um redirecionamento para uma origem que não é a permitida e que, se fosse seguido,
      // DEVOLVERIA um PNG: este mesmo servidor com outro nome (localhost ↔
      // 127.0.0.1). Assim o teste demonstra que o salto é revalidado, e não que
      // o destino falhou; e não sai da máquina.
      const aqui = new URL(req.url);
      const otro = aqui.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
      return new Response(null, {
        status: 302,
        headers: {
          location: `${aqui.protocol}//${otro}:${aqui.port}/api/dev/wa-mock/media-file/creativo-destino-del-salto`,
        },
      });
    }
    const vez = (pedidos.get(id) ?? 0) + 1;
    pedidos.set(id, vez);
    if (id.startsWith("creativo-lento") && vez === 1) {
      // A primeira vez demora mais que o tempo de espera da cópia.
      await new Promise((r) => setTimeout(r, 6_500));
    }
    if (id.startsWith("creativo-falla") && vez <= 2) {
      // Falha a cópia e a sua nova tentativa; na terceira, já responde.
      return new Response(null, { status: 503 });
    }
    return new Response(new Uint8Array(pngDePrueba(id)), {
      headers: { "content-type": "image/png" },
    });
  }

  const isPdf = id.includes("pdf");
  return new Response(Buffer.from("wa-mock-media"), {
    headers: {
      "content-type": isPdf ? "application/pdf" : "image/jpeg",
    },
  });
}
