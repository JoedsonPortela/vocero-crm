import { redirect } from "next/navigation";
import { getSessionOrNull } from "@/lib/auth/session";
import { todayInTz } from "@/lib/time/slots";
import { getBranding } from "@/server/branding";
import { agendaEnabled } from "@/server/agenda/flag";
import { businessTimezone } from "@/server/analytics/period";
import { ResultsClient } from "@/components/results/results-client";

export const dynamic = "force-dynamic";

/**
 * 019 — Resultados. Sempre disponível: não depende de nada externo, então não
 * tem flag (spec 019, D3).
 *
 * Moeda, fuso e "hoje" são resolvidos no servidor e descem como props: se
 * fossem pedidos pelo cliente, a tela renderizaria por um instante com a moeda ou o dia
 * errados, e os atalhos do intervalo não coincidiriam com os do servidor.
 */
export default async function ResultsPage() {
  // O layout já manda para o login sem sessão; isto é por precaução, caso a página
  // seja resolvida primeiro.
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  const [branding, timezone] = await Promise.all([
    getBranding(session.organizationId),
    businessTimezone(session.organizationId),
  ]);
  return (
    <ResultsClient
      currency={branding.currency}
      agenda={agendaEnabled()}
      today={todayInTz(new Date(), timezone)}
      timezone={timezone}
    />
  );
}
