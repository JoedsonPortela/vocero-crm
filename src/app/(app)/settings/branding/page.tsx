import { BrandingClient } from "@/components/settings/branding-client";
import { FaviconCard } from "@/components/settings/favicon-card";
import { getBranding } from "@/server/branding";
import { getSessionOrNull } from "@/lib/auth/session";
import { enabledChannels } from "@/server/channels/enabled";
import { navKicker } from "@/lib/channels";

export const dynamic = "force-dynamic";

export default async function BrandingSettingsPage() {
  // A marca é lida no servidor para que o cartão do ícone já pinte a
  // prévia correta na primeira renderização, sem um piscar do gerado para o
  // enviado enquanto um fetch do cliente vai e volta.
  const session = await getSessionOrNull();
  const branding = await getBranding(session?.organizationId);

  return (
    <div className="max-w-2xl space-y-6">
      {/* A logo viaja como prop: ao enviá-la ou removê-la, o FaviconCard atualiza
          a página e a prévia da marca acompanha sem recarregar. */}
      <BrandingClient
        favicon={branding.favicon}
        kicker={navKicker([...enabledChannels()])}
      />
      <FaviconCard branding={branding} />
    </div>
  );
}
