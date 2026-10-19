import { InboxClient } from "@/components/inbox/inbox-client";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { CHANNEL_ORDER } from "@/lib/channels";
import { enabledChannels } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  /**
   * 014 — Quais inboxes existem é decidido no servidor, e não olhando os dados.
   * Se fosse deduzido das conversas carregadas, a marca do canal apareceria
   * e sumiria sozinha: uma instância com Instagram ligado mas sem DMs
   * ainda pareceria uma instância de canal único, e a primeira mensagem
   * redesenharia a lista inteira.
   */
  const enabled = enabledChannels();
  const channels = CHANNEL_ORDER.filter((c) => enabled.has(c));

  // 026 — Excluir uma conversa é de quem administra o negócio. O
  // servidor exige isso na rota; isto só decide se a opção é mostrada.
  const session = await getSessionOrNull();

  return <InboxClient channels={channels} canDelete={canConfigure(session?.role)} />;
}
