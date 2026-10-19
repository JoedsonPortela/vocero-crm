import { redirect } from "next/navigation";
import { getSessionOrNull } from "@/lib/auth/session";
import { guideFirst } from "@/server/onboarding/guide";

export const dynamic = "force-dynamic";

/**
 * A raiz decide para onde se entra (issue #86): enquanto faltar um passo do
 * guia de início ou o agente estiver desligado, vai para `/onboarding`; com tudo pronto,
 * para a Bandeja como sempre. Sem sessão, `/inbox` manda para o login.
 */
export default async function Home() {
  const session = await getSessionOrNull();
  if (session && (await guideFirst(session))) redirect("/onboarding");
  redirect("/inbox");
}
