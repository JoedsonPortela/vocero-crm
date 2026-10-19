import { notFound } from "next/navigation";
import { TiktokClient } from "@/components/settings/tiktok-client";
import { isChannelEnabled } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function TiktokSettingsPage() {
  // Sem o canal ligado, esta tela não existe nesta instância (ADR-001).
  if (!isChannelEnabled("tiktok")) notFound();
  return <TiktokClient />;
}
