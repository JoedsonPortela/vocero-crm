"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import type { Branding } from "@/lib/branding";
import type { ThemePreference } from "@/lib/theme";
import type { ResolvedCommit } from "@/lib/version";
import { AppNav } from "@/components/app-nav";
import { BrandLogo } from "@/components/brand-mark";
import { t } from "@/lib/i18n";

/**
 * Casca do app em dois modos:
 *
 * - Desktop (lg+): o painel lateral é uma coluna fixa, como sempre.
 * - Mobile/tablet: a lateral sai pela esquerda como gaveta sobre um véu,
 *   e no topo fica uma barra azul-marinho com o hambúrguer e a marca. A
 *   gaveta fecha sozinha ao navegar (o `pathname` muda) e com Escape.
 *
 * A altura usa `100dvh` (não `100vh`) porque no navegador mobile a barra de
 * endereços encolhe ao rolar: com `vh` o compositor da Bandeja
 * fica abaixo da borda visível.
 */
export function AppShell({
  branding,
  userName,
  role,
  theme,
  commit,
  agenda = false,
  kicker,
  aviso = null,
  children,
}: {
  branding: Branding;
  userName: string;
  role: string;
  theme: ThemePreference;
  /** Commit resolvido no servidor, com sua procedência (ver `resolveCommit`). */
  commit?: ResolvedCommit;
  /** 015 — Esta instância tem agenda? Quem decide é o servidor. */
  agenda?: boolean;
  /** 028 — O rótulo sob o logo (`navKicker`). */
  kicker?: string;
  /**
   * Faixa de aviso acima de TODA a aplicação (#85).
   *
   * Fica aqui e não dentro de uma tela porque o que anuncia não é de uma
   * tela: é que o agente não consegue responder. Quem tem esse problema
   * não está olhando Ajustes, está olhando a sua Bandeja e se perguntando por que
   * ninguém responde.
   */
  aviso?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  // Navegar = fechar a gaveta. Sem isso, tocar em "Pipeline" deixa o véu por cima
  // da tela recém-carregada.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {navOpen && (
        <button
          aria-label={t("shell.closeMenu")}
          tabIndex={-1}
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-overlay lg:hidden"
        />
      )}

      <AppNav
        branding={branding}
        commit={commit}
        userName={userName}
        role={role}
        theme={theme}
        agenda={agenda}
        kicker={kicker}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mesma peça da barra lateral (`nav-dark`): no celular a
            faixa azul-marinho do topo é o que resta do bicolor. */}
        <header className="nav-dark flex h-12 shrink-0 items-center gap-1.5 border-b bg-subtle px-2 text-foreground lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label={t("shell.openMenu")}
            aria-expanded={navOpen}
            className="rounded-md p-2 text-text-2 hover:bg-accent hover:text-foreground"
          >
            <Menu className="h-5 w-5" strokeWidth={1.8} />
          </button>
          <BrandLogo branding={branding} className="min-w-0" />
        </header>

        {aviso}

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
