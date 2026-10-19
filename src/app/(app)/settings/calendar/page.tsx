import { notFound } from "next/navigation";
import { AgendaClient } from "@/components/settings/agenda-client";
import { agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

export default function AgendaSettingsPage() {
  // Sem a flag, esta tela não existe nesta instância.
  if (!agendaEnabled()) notFound();
  return <AgendaClient />;
}
