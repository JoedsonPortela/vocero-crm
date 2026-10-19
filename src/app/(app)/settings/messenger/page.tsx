import { notFound } from "next/navigation";
import { MessengerClient } from "@/components/settings/messenger-client";
import { isChannelEnabled } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function MessengerSettingsPage() {
  // Sem o canal ligado, esta tela não existe nesta instância (ADR-001).
  if (!isChannelEnabled("messenger")) notFound();
  return <MessengerClient />;
}
