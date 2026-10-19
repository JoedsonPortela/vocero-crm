import { notFound } from "next/navigation";
import { AdsClient } from "@/components/settings/ads-client";
import { atribucionEnabled } from "@/server/attribution/flag";

export const dynamic = "force-dynamic";

export default function AdsSettingsPage() {
  // Sem a flag, esta tela não existe nesta instância.
  if (!atribucionEnabled()) notFound();
  return <AdsClient />;
}
