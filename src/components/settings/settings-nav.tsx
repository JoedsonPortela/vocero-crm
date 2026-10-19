"use client";

import { t } from "@/lib/i18n";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { settingsSections } from "@/lib/nav";

/**
 * #87 — Ajustes em três seções (Canais, Agente, Negócio). Quais links
 * existem quem decide é o servidor, que os envia por prop: este é um componente de
 * cliente e não pode ler variáveis de ambiente.
 *
 * Abaixo de `sm` as seções ficam numa linha que rola, cada uma
 * com seu cabeçalho à frente de seus links, para que no celular continue
 * sendo uma faixa de abas navegável e não uma coluna que empurre o
 * conteúdo para baixo.
 */
export function SettingsNav({
  agenda = false,
  atribucion = false,
  instagram = false,
  messenger = false,
  tiktok = false,
}: {
  agenda?: boolean;
  atribucion?: boolean;
  instagram?: boolean;
  messenger?: boolean;
  tiktok?: boolean;
}) {
  const pathname = usePathname();
  const sections = settingsSections({ agenda, atribucion, instagram, messenger, tiktok });
  return (
    <nav
      aria-label={t("settings.settingsLabel")}
      className="flex shrink-0 gap-4 overflow-x-auto border-b px-2 py-2 sm:w-48 sm:flex-col sm:gap-5 sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3"
    >
      {sections.map((section) => (
        <div
          key={section.title}
          className="flex shrink-0 items-center gap-1 sm:flex-col sm:items-stretch sm:gap-0.5"
        >
          <span className="kicker mr-1 shrink-0 sm:mb-1 sm:mr-0 sm:px-3">{section.title}</span>
          {section.links.map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block shrink-0 whitespace-nowrap rounded-sm px-3 py-2 text-[13.5px] font-semibold transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-brand-tint text-brand-text"
                    : "text-text-2 hover:bg-accent hover:text-foreground"
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
