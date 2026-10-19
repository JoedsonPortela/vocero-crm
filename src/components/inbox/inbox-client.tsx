"use client";

import { t } from "@/lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, PanelRight } from "lucide-react";
import { cn, formatPhone } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import type { ConversationDto, MessageDto } from "@/lib/types";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { ChannelBadge } from "@/components/channel-badge";
import { useEvents } from "@/components/use-events";
import { ConversationList } from "./conversation-list";
import { MessageThread } from "./message-thread";
import { Composer } from "./composer";
import { ContactPanel } from "./contact-panel";

/**
 * Texto que já saiu do compositor mas cujo POST ainda está em trânsito. Existe só
 * no cliente: é desenhado como bolha "enviando" para que escrever a
 * próxima linha não espere a Meta (~1,5 s de ida e volta).
 */
type PendingOut = {
  id: string;
  conversationId: string;
  text: string;
  createdAt: string;
};

/**
 * `xl` é o limite onde cabem as três colunas (lista + conversa + detalhes).
 * Abaixo, o painel de detalhes flutua sobre a conversa. Deve coincidir com o
 * breakpoint `xl:` que usam as classes da seção de detalhes.
 */
const PANEL_MEDIA_QUERY = "(min-width: 1280px)";
const isWideEnoughForPanel = () =>
  typeof window !== "undefined" && window.matchMedia(PANEL_MEDIA_QUERY).matches;

export function InboxClient({
  channels,
  canDelete = false,
}: {
  channels: readonly Channel[];
  /** 026 — Excluir é irreversível: só quem administra vê a opção. */
  canDelete?: boolean;
}) {
  const multiChannel = channels.length > 1;
  const [conversations, setConversations] = useState<ConversationDto[] | null>(
    null
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [pending, setPending] = useState<PendingOut[]>([]);
  // Começa fechado: em telas estreitas o painel de detalhes é uma gaveta
  // POR CIMA da conversa, então abri-lo por padrão taparia a conversa. O
  // efeito abaixo o abre sozinho somente se houver de fato três colunas de largura.
  const [panelOpen, setPanelOpen] = useState(false);
  // É incrementado a cada evento SSE que pode mudar a etapa/lead ou o
  // estado do agente: o painel de detalhes o observa e faz nova busca ao vivo.
  const [detailRev, setDetailRev] = useState(0);

  useEffect(() => {
    if (!isWideEnoughForPanel()) return;
    setPanelOpen(localStorage.getItem("vocero.panelOpen") !== "false");
  }, []);
  const togglePanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    // A preferência é de desktop: abrir a gaveta no celular não deve
    // reescrever como fica a Bandeja no computador.
    if (isWideEnoughForPanel()) {
      localStorage.setItem("vocero.panelOpen", String(open));
    }
  }, []);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const lastFetchRef = useRef<string | null>(null);
  const tmpSeq = useRef(0);
  // Os envios saem em fila: o compositor já não espera, mas o WhatsApp deve
  // receber "hola" antes da linha seguinte. Sem essa cadeia, dois POST
  // simultâneos podem chegar à Meta fora de ordem.
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());

  const refetchConversations = useCallback(async () => {
    const res = await fetch("/api/conversations").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { conversations: ConversationDto[] };
    setConversations(data.conversations);
    lastFetchRef.current = new Date().toISOString();
  }, []);

  const refetchMessages = useCallback(async (conversationId: string) => {
    const res = await fetch(
      `/api/conversations/${conversationId}/messages`
    ).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { messages: MessageDto[] };
    if (selectedIdRef.current === conversationId) setMessages(data.messages);
  }, []);

  useEffect(() => {
    void refetchConversations();
  }, [refetchConversations]);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMessages([]);
      void refetchMessages(id);
      void fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markRead: true }),
      });
    },
    [refetchMessages]
  );

  /** 026 — Remove uma conversa excluída de tudo o que esta aba lembra. */
  const quitarConversacion = useCallback((id: string) => {
    setConversations((prev) => prev?.filter((c) => c.id !== id) ?? prev);
    setPending((prev) => prev.filter((p) => p.conversationId !== id));
    if (selectedIdRef.current === id) {
      setSelectedId(null);
      setMessages([]);
    }
  }, []);

  // Link direto a partir de Contactos/Pipeline: /inbox?contact=<id>
  const searchParams = useSearchParams();
  const contactParam = searchParams.get("contact");
  useEffect(() => {
    if (!contactParam || selectedIdRef.current) return;
    const match = conversations?.find((c) => c.contact.id === contactParam);
    if (match) select(match.id);
  }, [contactParam, conversations, select]);

  useEvents({
    onMessageNew: ({ conversationId, message }) => {
      if (selectedIdRef.current === conversationId) {
        const m = message as MessageDto;
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m]
        );
        void fetch(`/api/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ markRead: true }),
        });
      }
      void refetchConversations();
      // Uma mensagem recebida nova pode criar/mover o lead: atualiza o painel.
      setDetailRev((v) => v + 1);
    },
    onMessageStatus: ({ conversationId, messageId, status, error }) => {
      if (selectedIdRef.current !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                status: status as MessageDto["status"],
                error: error ?? null,
              }
            : m
        )
      );
    },
    onConversationUpdated: () => {
      void refetchConversations();
      // O agente mudou de etapa ou trocou o handoff: atualiza o painel ao vivo.
      setDetailRev((v) => v + 1);
    },
    onConversationDeleted: ({ conversationId }) => {
      // 026: alguém da equipe a excluiu (ou esta mesma aba). É removida
      // já, sem esperar a nova busca, para que ninguém escreva para uma conversa que
      // não existe.
      quitarConversacion(conversationId);
      void refetchConversations();
    },
    onReconnect: () => {
      // Recuperação após reconexão (contrato sse.md): nova busca completa.
      void refetchConversations();
      if (selectedIdRef.current) void refetchMessages(selectedIdRef.current);
      setDetailRev((v) => v + 1);
    },
  });

  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  /**
   * Conversa visível = o confirmado + o que ainda está em trânsito. A mensagem real pode
   * chegar por nova busca ou por SSE antes de retirarmos a provisória, então
   * cada pendente é pareado com UMA mensagem real (não por texto solto:
   * enviar "hola" duas vezes seguidas não deve apagar a segunda bolha).
   */
  const thread = useMemo(() => {
    const propios = pending.filter((p) => p.conversationId === selectedId);
    if (propios.length === 0) return messages;
    const emparejados = new Set<string>();
    const visibles = propios.filter((p) => {
      const real = messages.find(
        (m) =>
          !emparejados.has(m.id) &&
          m.direction === "out" &&
          m.text === p.text &&
          Date.parse(m.createdAt) >= Date.parse(p.createdAt) - 60_000
      );
      if (real) emparejados.add(real.id);
      return !real;
    });
    if (visibles.length === 0) return messages;
    return [
      ...messages,
      ...visibles.map<MessageDto>((p) => ({
        id: p.id,
        conversationId: p.conversationId,
        direction: "out",
        type: "text",
        text: p.text,
        status: "pending",
        error: null,
        aiGenerated: false,
        origin: "operator",
        media: null,
        createdAt: p.createdAt,
      })),
    ];
  }, [messages, pending, selectedId]);

  /**
   * O compositor NÃO espera que isto termine: limpa o seu campo na hora e
   * aqui é desenhada a bolha "enviando". Se o envio falhar, a bolha é
   * retirada e o erro volta ao compositor, que devolve o texto — uma mensagem
   * jamais se perde em silêncio.
   */
  const sendText = useCallback(
    async (text: string): Promise<string | null> => {
      const conversationId = selectedIdRef.current;
      if (!conversationId) return t("inbox.noConversation");

      const tmpId = `tmp_${++tmpSeq.current}`;
      setPending((prev) => [
        ...prev,
        {
          id: tmpId,
          conversationId,
          text,
          createdAt: new Date().toISOString(),
        },
      ]);
      const drop = () => setPending((prev) => prev.filter((p) => p.id !== tmpId));

      const run = async (): Promise<string | null> => {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }).catch(() => null);
        if (!res) {
          drop();
          return t("inbox.noServer");
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          drop();
          return data?.error?.message ?? t("inbox.sendFailed");
        }
        // Primeiro trazer a mensagem real, depois remover a provisória: ao
        // contrário, a bolha piscaria.
        await refetchMessages(conversationId);
        drop();
        void refetchConversations();
        return null;
      };

      const queued = sendQueue.current.then(run, run);
      sendQueue.current = queued.catch(() => null);
      return queued;
    },
    [refetchMessages, refetchConversations]
  );

  const patchConversation = useCallback(
    async (patch: { aiEnabled?: boolean; reactivate?: boolean }) => {
      if (!selectedIdRef.current) return;
      await fetch(`/api/conversations/${selectedIdRef.current}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => null);
      void refetchConversations();
    },
    [refetchConversations]
  );

  /** 026 — Devolve a mensagem de erro, ou null se a conversa não existir mais. */
  const deleteConversation = useCallback(
    async (alsoContact: boolean): Promise<string | null> => {
      const id = selectedIdRef.current;
      if (!id) return t("inbox.noConversation");
      const res = await fetch(
        `/api/conversations/${id}${alsoContact ? "?contacto=1" : ""}`,
        { method: "DELETE" }
      ).catch(() => null);
      if (!res) return t("inbox.noServer");
      // 404 = outra pessoa a excluiu antes: para quem pediu, já está feito.
      if (!res.ok && res.status !== 404) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        return data?.error?.message ?? t("inbox.deleteFailed");
      }
      quitarConversacion(id);
      void refetchConversations();
      return null;
    },
    [quitarConversacion, refetchConversations]
  );

  return (
    <div className="flex h-full">
      {/* Mobile: uma coluna por vez. A lista cede a tela inteira à
          conversa assim que há uma conversa escolhida (padrão mestre-detalhe). */}
      <section
        className={cn(
          "w-full shrink-0 overflow-hidden border-r md:w-[300px] lg:w-[360px]",
          selected && "max-md:hidden"
        )}
      >
        <ConversationList
          conversations={conversations}
          channels={channels}
          selectedId={selectedId}
          onSelect={select}
          onSeeded={() => void refetchConversations()}
        />
      </section>

      <section
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          !selected && "max-md:hidden"
        )}
      >
        {selected ? (
          <>
            <header className="flex items-center justify-between gap-1 border-b bg-background px-2 py-2.5 md:px-4">
              {/* Voltar à lista: no mobile a conversa ocupa a tela toda. */}
              <button
                onClick={() => setSelectedId(null)}
                aria-label={t("inbox.backToList")}
                className="shrink-0 rounded-md p-1.5 text-text-2 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={1.8} />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-3 p-1">
                <ContactAvatar
                  name={selected.contact.name}
                  seed={selected.contact.id}
                  size="md"
                />
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-bold leading-tight tracking-tight">
                    {multiChannel && <ChannelBadge channel={selected.channel} />}
                    <span className="truncate">{selected.contact.name}</span>
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 font-mono text-[10.5px] tracking-[0.04em]",
                      selected.windowOpen
                        ? "font-medium text-success-text"
                        : selected.humanWindow?.open
                          ? "font-medium text-info-text"
                          : "text-text-3"
                    )}
                  >
                    {selected.windowOpen
                      ? "ventana abierta"
                      : selected.humanWindow?.open
                        ? // 024: passadas 24 h no Instagram ou no Messenger só
                          // responde uma pessoa. Não se chama «atendimento
                          // humano»: isso já é o repasse, com a IA em pausa.
                          "ventana humana"
                        : selected.contact.phone
                        ? formatPhone(selected.contact.phone)
                        : // O Instagram não tem telefone: dizer "Sin teléfono"
                          // seria responder a uma pergunta que ninguém fez.
                          CHANNEL_LABEL[selected.channel]}
                  </p>
                </div>
              </div>
              {!panelOpen && (
                <button
                  onClick={() => togglePanel(true)}
                  aria-label={t("inbox.showDetails")}
                  className="shrink-0 rounded-full border border-border-strong p-1.5 text-text-3 transition-colors hover:border-text-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PanelRight className="h-4 w-4" strokeWidth={1.7} />
                </button>
              )}
            </header>
            <MessageThread messages={thread} />
            <Composer
              // 028: um por conversa. Sem a chave, o rascunho, o anexo
              // escolhido e o painel aberto passavam para a conversa seguinte.
              key={selected.id}
              conversation={selected}
              onSend={sendText}
              onSent={() => {
                if (selectedIdRef.current)
                  void refetchMessages(selectedIdRef.current);
                void refetchConversations();
              }}
            />
          </>
        ) : (
          <div className="thread-bg flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="font-serif text-[24px] italic leading-tight text-text-2">
              Elige una conversación para ver el hilo
            </p>
            <p className="kicker">{t("inbox.kicker")}</p>
          </div>
        )}
      </section>

      {/* Véu da gaveta de detalhes (só onde não cabem três colunas). */}
      {panelOpen && selected && (
        <button
          aria-label={t("inbox.closeDetails")}
          tabIndex={-1}
          onClick={() => togglePanel(false)}
          className="fixed inset-0 z-30 bg-overlay xl:hidden"
        />
      )}

      <section
        className={cn(
          "shrink-0 overflow-hidden border-l transition-[width] duration-200",
          // Abaixo de xl não há largura para uma terceira coluna: o painel
          // vira uma gaveta que entra pela direita, por cima da conversa.
          "max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-40 max-xl:w-auto max-xl:bg-popover max-xl:transition-transform",
          panelOpen && selected
            ? "w-[320px] max-xl:translate-x-0 max-xl:shadow-pop"
            : "w-0 border-l-0 max-xl:translate-x-full"
        )}
      >
        {selected && (
          <div className="h-full w-[320px] max-xl:w-[min(320px,88vw)]">
            <ContactPanel
              conversation={selected}
              refreshKey={detailRev}
              onPatchConversation={patchConversation}
              onDeleteConversation={canDelete ? deleteConversation : undefined}
              onClose={() => togglePanel(false)}
            />
          </div>
        )}
      </section>
    </div>
  );
}
