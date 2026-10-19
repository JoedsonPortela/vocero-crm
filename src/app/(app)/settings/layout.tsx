import { t } from "@/lib/i18n";
import { SettingsNav } from "@/components/settings/settings-nav";
import { agendaEnabled } from "@/server/agenda/flag";
import { atribucionEnabled } from "@/server/attribution/flag";
import { isChannelEnabled } from "@/server/channels/enabled";

// A flag é lida a cada requisição: se isto fosse resolvido no build, a
// imagem ficaria com a agenda desligada para sempre, e ligá-la na
// plataforma não faria nada.
export const dynamic = "force-dynamic";

export default function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="text-[17px] font-bold tracking-tight">{t("settings.configTitle")}</h2>
      </header>
      {/* No celular, as abas ficam no topo (em linha), e não como coluna lateral. */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <SettingsNav
          agenda={agendaEnabled()}
          atribucion={atribucionEnabled()}
          instagram={isChannelEnabled("instagram")}
          messenger={isChannelEnabled("messenger")}
          tiktok={isChannelEnabled("tiktok")}
        />
        <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}
