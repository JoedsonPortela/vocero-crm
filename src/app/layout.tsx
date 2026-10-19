import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Archivo, IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import { accentCssVariables, DEFAULT_BRANDING } from "@/lib/branding";
import { faviconHref } from "@/lib/favicon";
import { normalizeThemePreference, THEME_COOKIE } from "@/lib/theme";
import { getBranding } from "@/server/branding";
import { enabledChannels } from "@/server/channels/enabled";
import { productName } from "@/lib/channels";
import { LOCALE } from "@/lib/i18n";
import "./globals.css";

// As três vozes da marca, as mesmas do vocerocrm.com. next/font as
// baixa no BUILD e as serve self-hosted (sem CDN em runtime: soberania).
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getBranding().catch(() => DEFAULT_BRANDING);
  const producto = productName([...enabledChannels()]);
  return {
    title: `${branding.name} — ${producto}`,
    description: `${producto} con agente de IA y Laboratorio de auto-evaluación`,
    // O `?v=` muda com a marca: os navegadores guardam o favicon com uma
    // insistência notável e, sem isso, o logo novo leva dias para aparecer.
    icons: { icon: faviconHref(branding) },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const branding = await getBranding().catch(() => DEFAULT_BRANDING);
  const theme = normalizeThemePreference(
    (await cookies()).get(THEME_COOKIE)?.value
  );
  return (
    <html
      lang={LOCALE}
      className={`${archivo.variable} ${instrumentSerif.variable} ${plexMono.variable}`}
      // A preferência é sempre explícita: o tema vai resolvido no HTML
      // do servidor, então não há divergência com o cliente nem piscar.
      data-theme={theme}
    >
      <head>
        {/* Acento white-label injetado no SSR: sem flash de tema */}
        <style
          dangerouslySetInnerHTML={{ __html: accentCssVariables(branding.accent) }}
        />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
