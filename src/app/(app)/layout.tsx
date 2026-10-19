import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSessionOrNull } from "@/lib/auth/session";
import { normalizeThemePreference, THEME_COOKIE } from "@/lib/theme";
import { getBranding } from "@/server/branding";
import { AppShell } from "@/components/app-shell";
import { resolveCommit } from "@/lib/version";
import { agendaEnabled } from "@/server/agenda/flag";
import { enabledChannels } from "@/server/channels/enabled";
import { navKicker } from "@/lib/channels";
import { avisoIaDe } from "@/server/ai/aviso";
import { AvisoIaBanner } from "@/components/avisos/aviso-ia";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  const branding = await getBranding(session.organizationId);
  const authSession = await getAuth().api.getSession({
    headers: await headers(),
  });
  const theme = normalizeThemePreference(
    (await cookies()).get(THEME_COOKIE)?.value
  );
  // O agente ligado e sem com que pensar aparece de fora igual a um
  // bot quebrado. Resolve-se no servidor e no layout para que apareça em
  // QUALQUER tela, não só no painel de um contato (#85).
  const aviso = await avisoIaDe(session.organizationId);

  return (
    <AppShell
      branding={branding}
      userName={authSession?.user.name ?? "Usuario"}
      role={session.role}
      theme={theme}
      // Resolve-se aqui, no servidor: o cliente não vê `SOURCE_COMMIT`.
      // Desce com a sua procedência, para que o selo não apresente como
      // verificado um commit que não saiu do build (#50).
      commit={resolveCommit()}
      // Quais módulos opcionais existem é decidido no servidor e desce por
      // prop, igual aos canais da Bandeja. O nav é um componente de
      // cliente: não pode — nem deve — ler variáveis de ambiente.
      agenda={agendaEnabled()}
      kicker={navKicker([...enabledChannels()])}
      aviso={<AvisoIaBanner aviso={aviso} />}
    >
      {children}
    </AppShell>
  );
}
