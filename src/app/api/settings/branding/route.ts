import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getSessionOrNull } from "@/lib/auth/session";
import { isValidHex, resolveAccentSet } from "@/lib/branding";
import { CURRENCIES } from "@/lib/money";
import { getBranding, saveBranding } from "@/server/branding";

export const dynamic = "force-dynamic";

/** GET público: o login precisa da marca antes de autenticar. */
export async function GET() {
  const session = await getSessionOrNull();
  const branding = await getBranding(session?.organizationId);
  return Response.json({ branding, accentSet: resolveAccentSet(branding.accent) });
}

const putSchema = z.object({
  name: z.string().trim().min(1).max(30),
  accent: z.string().refine(isValidHex, "Cor hex inválida (#rrggbb)"),
  /** A moeda do negócio: a única que o quadro soma. */
  currency: z.enum(CURRENCIES),
});

export const PUT = withAuth(async (session, req: Request) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Somente o proprietário pode alterar a marca");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  // O ícone é preservado: este formulário trata de nome, cor e moeda, e o ícone
  // é enviado e removido pela sua própria rota. Sem isso, salvar o nome apagaria
  // a logo sem que ninguém tivesse pedido.
  const actual = await getBranding(session.organizationId);
  await saveBranding(session.organizationId, {
    ...body.data,
    favicon: actual.favicon,
  });
  return Response.json({ ok: true });
});
