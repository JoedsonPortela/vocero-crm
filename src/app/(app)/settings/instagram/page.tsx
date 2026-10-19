import { notFound } from "next/navigation";
import { InstagramClient } from "@/components/settings/instagram-client";
import { isChannelEnabled } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function InstagramSettingsPage() {
  // Sem o canal ligado, esta tela não existe nesta instância (ADR-001).
  if (!isChannelEnabled("instagram")) notFound();
  return <InstagramClient />;
}
