"use client";

import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, LogOut, X } from "lucide-react";
import type { Branding } from "@/lib/branding";
import type { ThemePreference } from "@/lib/theme";
import { cn, initials } from "@/lib/utils";
import { appNavGroups, isNavActive, SETTINGS_ITEM, type NavItem } from "@/lib/nav";
import { signOut } from "@/lib/auth/client";
import { useEvents } from "@/components/use-events";
import { ThemeToggle } from "@/components/theme-toggle";
import { BrandLogo } from "@/components/brand-mark";
import {
  BUILD_COMMIT,
  UNVERIFIED_COMMIT_NOTE,
  versionLabel,
  versionTitle,
  type ResolvedCommit,
} from "@/lib/version";

/**
 * Uma linha do menu, como o `side-item` do mockup da landing: texto
 * semibold, cantos de 9px e, ativo, um véu do acento com tinta azul.
 * Exportado para a pré-visualização de Configuração → Marca, que pinta a barra.
 */
export function navItemClass(active: boolean) {
  return cn(
    "flex items-center gap-[10px] rounded-sm px-2.5 py-2.5 text-[13.5px] font-semibold transition-colors lg:py-2",
    // Acento sólido: dentro de `.nav-dark` é o calculado para fundo escuro,
    // então contrasta com a barra (≥ 3.5:1) seja qual for o white-label.
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-brand-tint text-brand-text"
      : "text-text-2 hover:bg-accent hover:text-foreground"
  );
}

export function AppNav({
  branding,
  userName,
  role,
  theme,
  commit,
  agenda = false,
  kicker = "CRM · WhatsApp",
  open = false,
  onClose,
}: {
  branding: Branding;
  userName: string;
  role: string;
  theme: ThemePreference;
  /**
   * Commit resolvido no servidor. Tem prioridade sobre o de build porque pode vir da
   * plataforma quando quem construiu não o passou como build-arg — e, nesse
   * caso, chega com `verified: false`, e a insígnia informa isso.
   */
  commit?: ResolvedCommit;
  /** 028 — O rótulo sob o logo; quem decide é o servidor, pelos canais. */
  kicker?: string;
  /**
   * 015 — Há agenda nesta instância? Vem do servidor por prop e não é
   * deduzido dos dados: uma instância com a agenda ligada mas ainda sem reuniões
   * deve ver a entrada mesmo assim.
   */
  agenda?: boolean;
  /** Só se aplica abaixo de `lg`: no desktop a lateral é fixa. */
  open?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);

  async function refetchUnread() {
    const res = await fetch("/api/conversations").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as {
      conversations: { unreadCount: number }[];
    };
    setUnread(data.conversations.reduce((a, c) => a + c.unreadCount, 0));
  }

  useEffect(() => {
    void refetchUnread();
  }, []);

  useEvents({
    onMessageNew: () => void refetchUnread(),
    onConversationUpdated: () => void refetchUnread(),
  });

  const version = commit ?? { commit: BUILD_COMMIT, verified: BUILD_COMMIT !== "" };
  // #87 — O que há no menu e em qual grupo ele fica é decidido por `appNavGroups`; aqui
  // apenas é desenhado.
  const groups = appNavGroups({ agenda, role });

  function renderItem(item: NavItem) {
    const active = isNavActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={navItemClass(active)}
        aria-current={active ? "page" : undefined}
      >
        <item.icon
          className={cn("h-5 w-5 shrink-0", active ? "text-brand" : "text-text-3")}
          strokeWidth={1.8}
          aria-hidden
        />
        <span className="flex-1">{item.label}</span>
        {item.badge && unread > 0 && (
          <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1.5 text-[10.5px] font-bold text-brand-fg">
            {unread}
          </span>
        )}
      </Link>
    );
  }

  return (
    <aside
      // Mobile: gaveta que desliza pela esquerda (sempre montada, assim
      // a transição roda nos dois sentidos). Desktop: coluna fixa.
      // `visibility` fica na transição de propósito: ao fechar mantém o
      // painel visível enquanto desliza e só então o oculta, o que é
      // o que o tira da ordem de tabulação no mobile.
      className={cn(
        // `text-foreground` explícito: sem ele, o texto sem cor própria (o
        // nome do usuário, o nome white-label no BrandLogo) herda a
        // cor JÁ CALCULADA no <body> com o tema da página, e não a de
        // `.nav-dark` — e um texto escuro sobre este fundo escuro se perde.
        "nav-dark fixed inset-y-0 left-0 z-50 flex w-[17rem] shrink-0 flex-col overflow-y-auto border-r bg-subtle px-3 pb-3.5 pt-4 text-foreground transition-[transform,visibility] duration-200",
        "lg:static lg:visible lg:z-auto lg:w-56 lg:translate-x-0 lg:overflow-visible lg:transition-none",
        open ? "visible translate-x-0 shadow-pop" : "invisible -translate-x-full"
      )}
    >
      {/* Marca: o logo do Vocero ou, white-label, a inicial e o nome */}
      <div className="mb-5 flex items-start gap-1.5 px-2 pt-0.5">
        {/* No mobile a gaveta precisa do seu próprio fechamento: o véu nem sempre
            é alcançável com o polegar. */}
        <button
          onClick={onClose}
          aria-label={t("shell.closeMenu")}
          className="-ml-1 mt-0.5 rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground lg:hidden"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
        <div className="min-w-0">
          <BrandLogo branding={branding} />
          <span className="kicker mt-2 block">{kicker}</span>
        </div>
      </div>

      {/* Grupos com cabeçalho pequeno, sem letras nem recolhíveis: são lidos
          de cima para baixo como uma lista do que existe. Um grupo sem título
          (Resultados) é uma entrada avulsa separada pelo espaço. */}
      <nav className="flex flex-col gap-4" aria-label={t("shell.sections")}>
        {groups.map((group, i) => (
          <div key={group.title ?? i} className="flex flex-col gap-0.5">
            {group.title && (
              <span className="kicker mb-1 block px-2.5" aria-hidden>
                {group.title}
              </span>
            )}
            {group.items.map(renderItem)}
          </div>
        ))}
      </nav>

      <div className="flex-1" />

      {/* Ajustes fica embaixo, sozinho: não é trabalho do dia. */}
      {renderItem(SETTINGS_ITEM)}

      <div className="mt-1 flex items-center gap-2.5 rounded-sm px-2.5 py-2 hover:bg-accent">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-text">
          {initials(userName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{userName}</span>
          <span className="block truncate text-[11px] text-text-3">
            {role === "owner" ? "Proprietário" : "Equipe"} · Online
          </span>
        </span>
        <ThemeToggle initial={theme} />
        <button
          aria-label={t("shell.logout")}
          title={t("shell.logout")}
          className="rounded p-1 text-text-3 hover:text-foreground"
          onClick={async () => {
            await signOut();
            router.push("/login");
            router.refresh();
          }}
        >
          <LogOut className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>

      {/* Qual versão está rodando. Discreta mas sempre visível: a dúvida
          "já foi implantada?" aparece justo quando algo não funciona, e mandar
          alguém comparar commits no servidor significa que ela não fará isso. */}
      {/* `text-2` e não `text-3`: a 10.5px, o cinza mais claro não passa AA contra
          o fundo da barra. Discreta sim, ilegível não. */}
      {/* O nome sai da marca, não de uma constante: isto é white-label,
          e uma instância renomeada que diz "Vocero" no tooltip denuncia o
          produto de baixo justo onde o operador olha todo dia. */}
      {/* Um commit que não saiu do build avisa isso (#50): apresentá-lo igual
          a um verificado é o selo mentindo justo quando alguém o
          consulta para saber qual código roda. O aviso é o ícone (cor de
          alerta: basta 3:1 para um gráfico) e o texto fica em `text-2`,
          que passa AA sobre a barra em qualquer tema. */}
      <p
        className="mt-2 px-2.5 font-mono text-[10.5px] tracking-[0.06em] text-text-2"
        title={versionTitle(branding.name, version)}
      >
        {versionLabel(version.commit)}
        {version.commit && !version.verified && (
          <span className="mt-0.5 flex items-center gap-1">
            <AlertTriangle
              className="h-3 w-3 shrink-0 text-warning-text"
              strokeWidth={2}
              aria-hidden
            />
            {UNVERIFIED_COMMIT_NOTE}
          </span>
        )}
      </p>
    </aside>
  );
}
