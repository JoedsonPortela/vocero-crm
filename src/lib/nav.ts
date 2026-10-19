import {
  CalendarDays,
  ChartColumn,
  FlaskConical,
  Inbox,
  Kanban,
  ListChecks,
  Settings,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { canConfigure } from "@/lib/auth/roles";
import { t } from "@/lib/i18n";

/**
 * #87 — O modelo do menu, separado do componente que o desenha.
 *
 * Quais entradas existem é decidido por duas coisas que o nav do cliente não pode
 * ler sozinho: as flags da instância (`AGENDA`, `CHANNELS`, `ATRIBUCION`,
 * que descem por prop a partir do servidor) e o papel de quem olha. Tê-lo aqui,
 * sem React, permite que um teste unitário afirme o que aparece e o que não aparece sem
 * desenhar nada.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Mostra o contador de não lidas (só a Bandeja). */
  badge?: boolean;
};

export type NavGroup = {
  /** Cabeçalho pequeno; sem ele, o grupo é uma entrada avulsa. */
  title?: string;
  items: NavItem[];
};

/** A única entrada que fica embaixo, separada do resto. */
export const SETTINGS_ITEM: NavItem = {
  href: "/settings",
  label: t("nav.settings"),
  icon: Settings,
};

/**
 * Grupos da barra lateral, na ordem em que são lidos: o que se atende
 * todo dia, o que configura o agente e, no final, como vai o negócio.
 */
export function appNavGroups({
  agenda = false,
  role,
}: {
  /** 015 — "Citas" só existe se esta instância ligou a agenda. */
  agenda?: boolean;
  /** #86 — O guia inicial só para quem pode configurar. */
  role?: string | null;
}): NavGroup[] {
  const trabajo: NavItem[] = [
    { href: "/inbox", label: t("nav.inbox"), icon: Inbox, badge: true },
    { href: "/pipeline", label: t("nav.pipeline"), icon: Kanban },
    { href: "/contacts", label: t("nav.contacts"), icon: Users },
  ];
  // Agendamentos vem depois de Contatos: é o passo seguinte de um negócio, não uma
  // seção à parte.
  if (agenda) trabajo.push({ href: "/bookings", label: t("nav.bookings"), icon: CalendarDays });

  const agente: NavItem[] = [];
  // Um membro da equipe não pode fazer nenhum dos passos do guia.
  if (canConfigure(role)) {
    agente.push({ href: "/onboarding", label: t("nav.onboarding"), icon: ListChecks });
  }
  agente.push(
    { href: "/agent", label: t("nav.agent"), icon: Sparkles },
    { href: "/lab", label: t("nav.lab"), icon: FlaskConical }
  );

  return [
    { title: "Trabajo", items: trabajo },
    { title: "Agente", items: agente },
    // 019 — Mede-se no final: primeiro se atende e se organiza.
    { items: [{ href: "/results", label: t("nav.results"), icon: ChartColumn }] },
  ];
}

export type SettingsLink = { href: string; label: string };

export type SettingsSection = {
  title: string;
  links: SettingsLink[];
};

/**
 * Ajustes em três seções: por onde entram as mensagens, o que o agente faz
 * com elas e o que é do negócio. Uma aba por canal não escala; uma
 * seção por canal, sim: cada canal novo cai em "Canais" sem tocar no resto.
 *
 * O Instagram ainda não tem tela própria: suas credenciais são salvas
 * pela API (`/api/settings/instagram`). Quando tiver, vai aqui atrás de
 * `CHANNELS`, igual ao Messenger.
 */
export function settingsSections({
  agenda = false,
  atribucion = false,
  instagram = false,
  messenger = false,
  tiktok = false,
}: {
  agenda?: boolean;
  /** 016 — "Anúncios" existe só com a flag ATRIBUCION. */
  atribucion?: boolean;
  /** 023 — "Instagram" só se o canal estiver ligado com CHANNELS. */
  instagram?: boolean;
  /** 017 — "Messenger", igual. */
  messenger?: boolean;
  /** 022 — "TikTok", igual: só com o canal em CHANNELS. */
  tiktok?: boolean;
}): SettingsSection[] {
  const canales: SettingsLink[] = [];
  // 023 — "Status" reúne todos os canais; com só WhatsApp não acrescenta nada
  // que a sua tela não diga, então não existe (ADR-001).
  if (instagram || messenger || tiktok) {
    canales.push({ href: "/settings/channels", label: "Status" });
  }
  canales.push({ href: "/settings/whatsapp", label: "WhatsApp" });
  if (instagram) canales.push({ href: "/settings/instagram", label: "Instagram" });
  if (messenger) canales.push({ href: "/settings/messenger", label: "Messenger" });
  if (tiktok) canales.push({ href: "/settings/tiktok", label: "TikTok" });

  // #85 — o provedor de IA é configurado aqui; o ambiente fica como reserva.
  const agente: SettingsLink[] = [{ href: "/settings/ai", label: "IA" }];
  if (agenda) agente.push({ href: "/settings/calendar", label: "Agenda" });

  const negocio: SettingsLink[] = [
    { href: "/settings/branding", label: "Marca" },
    { href: "/settings/templates", label: "Modelos" },
    { href: "/settings/team", label: "Equipe" },
  ];
  if (atribucion) negocio.push({ href: "/settings/ads", label: "Anúncios" });

  return [
    { title: "Canais", links: canales },
    { title: "Agente", links: agente },
    { title: "Negócio", links: negocio },
  ];
}

/** Ativa se a rota é a entrada ou pende dela (`/inbox/cv_123`). */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
