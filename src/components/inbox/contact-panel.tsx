"use client";

import { t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Cable,
  Check,
  ChevronRight,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  externalAnswerLabel,
  externalAnswering,
  externalDown,
  type BrainStatusDto,
} from "@/lib/brain-status";
import type {
  AnuncioDto,
  ConversationDto,
  FichaDto,
  FichaValue,
  StageDto,
} from "@/lib/types";
import { cn, formatPhone } from "@/lib/utils";
import { AnuncioOrigen } from "@/components/anuncio-origen";
import { ContactAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FichaPanel } from "@/components/ficha-panel";
import { DeleteConversationDialog } from "./delete-conversation-dialog";

const HANDOFF_LABELS: Record<string, string> = {
  cliente: t("inbox.humanRequested"),
  modelo: t("inbox.agentEscalated"),
  error: "Error del proveedor de IA",
  ventana: "Ventana de 24h cerrada",
  manual_reply: t("inbox.repliedFromPhone"),
};

export function ContactPanel({
  conversation,
  refreshKey = 0,
  onPatchConversation,
  onDeleteConversation,
  onClose,
}: {
  conversation: ConversationDto;
  /** Aumenta a cada evento SSE relevante: dispara uma nova busca ao vivo. */
  refreshKey?: number;
  onPatchConversation: (patch: {
    aiEnabled?: boolean;
    reactivate?: boolean;
  }) => Promise<void>;
  /** 026 — Ausente = quem olha não pode excluir: não é oferecido. */
  onDeleteConversation?: (alsoContact: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [notes, setNotes] = useState("");
  const [ficha, setFicha] = useState<FichaDto>({});
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [stages, setStages] = useState<StageDto[]>([]);
  const [currentStageId, setCurrentStageId] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);
  // 018: de qual anúncio veio; null se escreveu por conta própria.
  const [anuncio, setAnuncio] = useState<AnuncioDto | null>(null);
  // Quem responde (agente incluído, cérebro externo ou os dois): sem isso, o
  // toggle "Respondendo" mentiria quando o agente ainda não foi
  // configurado/ligado, e pediria a chave de IA mesmo que a Nea respondesse.
  const [brain, setBrain] = useState<BrainStatusDto | null>(null);

  const contactId = conversation.contact.id;

  const aiConfigured = brain?.embedded.configured ?? false;
  const agentReady = brain?.embedded.answering ?? false;
  // Até onde se sabe, responde: ativo e, se houver /health, online.
  const externalActive = brain ? externalAnswering(brain) : false;
  // O controle é a FONTE DA VERDADE da conversa: o agente in-process
  // e qualquer cérebro externo conectado por /api/bot/* respeita esta flag,
  // então o toggle opera sempre — `agentReady` só matiza o texto.
  const aiActive = conversation.aiEnabled && !conversation.handoffAt;

  // À parte do resto: consultar o /health do cérebro externo pode demorar
  // até 2 s, e isso não deve atrasar a etapa nem a ficha.
  const loadBrain = useCallback(async () => {
    const b = await fetch("/api/agent/brain-status")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (b) setBrain(b);
  }, []);

  // Carga inicial (inclui notas): é reexecutada ao trocar de contato.
  const refetch = useCallback(async () => {
    void loadBrain();
    const [detail, stagesRes] = await Promise.all([
      fetch(`/api/contacts/${contactId}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/pipeline/stages").then((r) => (r.ok ? r.json() : null)),
    ]).catch(() => [null, null]);
    if (detail) {
      setNotes(detail.contact?.notes ?? "");
      setFicha(detail.contact?.ficha ?? {});
      setCurrentStageId(detail.stage?.id ?? null);
      setLeadId(detail.lead?.id ?? null);
      setAnuncio(detail.anuncio ?? null);
    }
    if (stagesRes) setStages(stagesRes.stages);
    setNotesLoaded(true);
  }, [contactId, loadBrain]);

  // Nova busca ao vivo (etapa/lead + quem responde) SEM tocar nas notas, para
  // não atropelar o que o operador estiver escrevendo. Quem dispara é o SSE.
  const refreshLive = useCallback(async () => {
    void loadBrain();
    const detail = await fetch(`/api/contacts/${contactId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (detail) {
      // A ficha SIM é atualizada ao vivo: o agente a vai preenchendo enquanto a
      // conversa acontece, e vê-la aparecer sozinha é exatamente para isso que serve.
      // Não atropela uma edição em andamento — o rascunho fica dentro do painel.
      setFicha(detail.contact?.ficha ?? {});
      setCurrentStageId(detail.stage?.id ?? null);
      setLeadId(detail.lead?.id ?? null);
      // A imagem do criativo é copiada depois que a mensagem entra: esta
      // nova busca ao vivo é o que a faz aparecer sem recarregar.
      setAnuncio(detail.anuncio ?? null);
    }
  }, [contactId, loadBrain]);

  useEffect(() => {
    setNotesLoaded(false);
    // Ao trocar de contato não pode aparecer o anúncio do anterior.
    setAnuncio(null);
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!notesLoaded) return; // a carga inicial já traz o estado atualizado
    void refreshLive();
  }, [refreshKey, notesLoaded, refreshLive]);

  async function moveToStage(stageId: string) {
    if (!leadId || stageId === currentStageId) return;
    setCurrentStageId(stageId); // otimista
    await fetch(`/api/pipeline/leads/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId, position: 0 }),
    }).catch(() => null);
    void refreshLive();
  }

  /** Envia SOMENTE o que mudou: o servidor faz merge (ver `server/bot/ficha`). */
  async function saveFicha(patch: Record<string, FichaValue | null>) {
    setFicha((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next; // otimista: a nova busca abaixo confirma
    });
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ficha: patch }),
    }).catch(() => null);
    void refreshLive();
  }

  async function saveNotes() {
    setSavingNotes(true);
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    }).catch(() => null);
    setSavingNotes(false);
  }

  const currentIndex = stages.findIndex((s) => s.id === currentStageId);

  return (
    <div className="flex h-full flex-col">
      {/* Abaixo de xl o painel flutua (bg-popover, ver InboxClient): seu
          cabeçalho segue o mesmo tom para não deixar uma faixa mais escura. */}
      <header className="sticky top-0 flex items-center justify-between border-b bg-background px-4 py-3 max-xl:bg-popover">
        <h3 className="kicker text-text-2">{t("inbox.details")}</h3>
        <button
          onClick={onClose}
          aria-label={t("inbox.hidePanel")}
          className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Contacto */}
        <section className="border-b p-4">
          <div className="flex items-center gap-3">
            <ContactAvatar
              name={conversation.contact.name}
              seed={conversation.contact.id}
              size="md"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold tracking-tight">
                {conversation.contact.name}
              </p>
              <p className="text-xs text-text-3">
                {formatPhone(conversation.contact.phone)}
              </p>
            </div>
          </div>

          {conversation.handoffAt && (
            <div className="mt-3 rounded-md border border-warning-soft bg-warning-tint p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-warning-text">
                <UserRound className="h-4 w-4" strokeWidth={1.7} /> Atención humana
              </p>
              <p className="mt-1 text-xs text-warning-text opacity-80">
                {HANDOFF_LABELS[conversation.handoffReason ?? ""] ??
                  t("inbox.aiPausedNote")}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 w-full"
                onClick={() => void onPatchConversation({ reactivate: true })}
              >
                Reactivar IA
              </Button>
            </div>
          )}

          <div className="mt-3 rounded-md border bg-subtle px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{t("inbox.aiHere")}</p>
                <p className="text-[11px] text-text-3">
                  {conversation.handoffAt
                    ? t("inbox.pausedHuman")
                    : !conversation.aiEnabled
                      ? t("inbox.paused")
                      : agentReady || externalActive
                        ? "Respondiendo"
                        : "Activada"}
                </p>
              </div>
              <Switch
                size="sm"
                checked={aiActive}
                label={t("inbox.aiHere")}
                onCheckedChange={() => {
                  void onPatchConversation({
                    aiEnabled: !conversation.aiEnabled,
                  });
                }}
              />
            </div>

            {brain?.warning === "doble_respuesta" ? (
              <div className="mt-2.5 flex items-start gap-2 rounded-md border border-danger-soft bg-danger-tint p-2.5">
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-text"
                  strokeWidth={1.7}
                />
                <div className="text-[11px] leading-relaxed text-danger-text">
                  <p>
                    <span className="font-semibold">{t("inbox.doubleReply")}</span> el agente
                    incluido y tu cerebro externo contestan a la vez.
                  </p>
                  <Link
                    href="/agent"
                    className="mt-1 inline-block font-medium underline underline-offset-2"
                  >
                    Revisar en Agente →
                  </Link>
                </div>
              </div>
            ) : brain && !agentReady && externalActive ? (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-3">
                <Cable className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
                {externalAnswerLabel(brain)}
              </p>
            ) : brain && !agentReady && externalDown(brain) ? (
              <div className="mt-2.5 flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-2.5">
                <Cable
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-text"
                  strokeWidth={1.7}
                />
                <p className="text-[11px] leading-relaxed text-warning-text">
                  Tu cerebro externo no está en línea: nadie contesta en automático
                  hasta que vuelva.
                  <Link
                    href="/agent"
                    className="ml-1 whitespace-nowrap font-medium text-brand-text underline underline-offset-2 hover:text-brand"
                  >
                    Ver en Agente →
                  </Link>
                </p>
              </div>
            ) : brain && !agentReady && (
              <div className="mt-2.5 flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-2.5">
                <Sparkles
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-text"
                  strokeWidth={1.7}
                />
                <p className="text-[11px] leading-relaxed text-warning-text">
                  {aiConfigured
                    ? t("inbox.agentOffNote")
                    : t("inbox.agentMissing")}
                  <Link
                    href={aiConfigured ? "/agent" : "/settings/ai"}
                    className="ml-1 whitespace-nowrap font-medium text-brand-text underline underline-offset-2 hover:text-brand"
                  >
                    {aiConfigured ? "Configurar agente →" : "Configurar la IA →"}
                  </Link>
                </p>
              </div>
            )}
          </div>

          {anuncio && (
            <div className="mt-3">
              <AnuncioOrigen anuncio={anuncio} />
            </div>
          )}
        </section>

        {/* Seletor de etapa */}
        {stages.length > 0 && leadId && (
          <section className="border-b p-4">
            <p className="kicker mb-3">{t("inbox.pipelineStage")}</p>
            <ol>
              {stages.map((s, i) => {
                const done = currentIndex >= 0 && i < currentIndex;
                const current = s.id === currentStageId;
                return (
                  <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < stages.length - 1 && (
                      <span
                        className={cn(
                          "absolute left-[7px] top-4 h-full w-px",
                          done ? "bg-brand" : "bg-border-strong"
                        )}
                      />
                    )}
                    <button
                      onClick={() => void moveToStage(s.id)}
                      aria-label={`Mover a ${s.name}`}
                      className={cn(
                        "relative z-10 mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full transition-colors",
                        done && "bg-brand text-brand-fg",
                        current && "bg-brand ring-4 ring-brand-soft",
                        !done && !current && "border border-border-strong bg-background hover:border-brand"
                      )}
                    >
                      {done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </button>
                    <button
                      onClick={() => void moveToStage(s.id)}
                      className={cn(
                        "text-left text-[13px]",
                        current ? "font-[650] text-brand-text" : "text-text-2 hover:text-foreground"
                      )}
                    >
                      {s.name}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {/* Ficha: o que se SABE do lead. Vem antes de Notas —o que alguém
            OPINA— porque é o que se consulta no meio de uma conversa. */}
        <FichaPanel ficha={ficha} onSave={saveFicha} />

        {/* Notas */}
        <section className={cn("p-4", onDeleteConversation && "border-b")}>
          <p className="kicker mb-2">{t("inbox.notes")}</p>
          <Textarea
            rows={5}
            placeholder={t("inbox.notesPlaceholder")}
            value={notes}
            disabled={!notesLoaded}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={savingNotes || !notesLoaded}
            onClick={() => void saveNotes()}
          >
            {savingNotes ? t("common.saving") : t("inbox.saveNotes")}
          </Button>
        </section>

        {/* 026 — No fundo e sem cor de alarme: fica à mão de quem a procura,
            não no caminho de quem só veio ler a ficha. */}
        {onDeleteConversation && (
          <section className="p-4">
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="flex items-center gap-1.5 rounded text-[13px] text-text-3 transition-colors hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
              Eliminar conversación…
            </button>
          </section>
        )}
      </div>

      {confirmingDelete && onDeleteConversation && (
        <DeleteConversationDialog
          contactName={conversation.contact.name}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={onDeleteConversation}
        />
      )}
    </div>
  );
}
