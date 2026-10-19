"use client";

import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import type { TemplateDto } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Conta {{1}}..{{n}} igual ao servidor, para pedir os seus valores. */
function countVariables(body: string): number {
  const found = new Set(
    Array.from(body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)).map((m) => m[1])
  );
  return found.size;
}

/**
 * Abrir conversa com quem nunca escreveu.
 *
 * O WhatsApp obriga a usar um modelo aprovado para escrever primeiro; não é
 * uma decisão do CRM. Se a janela de 24 h estiver aberta, este painel nem
 * aparece: gastar um modelo ali seria jogar dinheiro fora.
 */
export function StartConversation({
  contactId,
  onStarted,
}: {
  contactId: string;
  onStarted: (conversationId: string) => void;
}) {
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [vars, setVars] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/templates").catch(() => null);
      if (!res?.ok) return setTemplates([]);
      const data = (await res.json()) as { templates: TemplateDto[] };
      const aprobadas = data.templates.filter((t) => t.status === "approved");
      setTemplates(aprobadas);
      setTemplateId(aprobadas[0]?.id ?? "");
    })();
  }, []);

  const elegida = templates?.find((t) => t.id === templateId) ?? null;
  const nVars = elegida ? countVariables(elegida.body) : 0;

  async function enviar() {
    setEnviando(true);
    setError(null);
    const res = await fetch(`/api/contacts/${contactId}/start-conversation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateId,
        variables: nVars > 0 ? vars.slice(0, nVars) : undefined,
      }),
    }).catch(() => null);
    setEnviando(false);
    const data = (await res?.json().catch(() => null)) as
      | { error?: { message?: string }; conversationId?: string }
      | null;
    if (!res?.ok) {
      // A falha da Meta é explicada aqui mesmo (modelo pausado, número
      // que não o recebe…) em vez de se perder.
      setError(data?.error?.message ?? t("contacts.startFailed"));
      return;
    }
    onStarted(data?.conversationId ?? "");
  }

  if (templates === null) {
    return <p className="text-xs text-text-3">Cargando plantillas…</p>;
  }

  if (templates.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-subtle px-3 py-2.5">
        <p className="text-[13px]">
          Esta persona nunca te ha escrito, así que WhatsApp solo permite
          contactarla con una <strong>plantilla aprobada</strong>, y todavía no
          tienes ninguna.
        </p>
        <Link href="/settings/templates">
          <Button size="sm" variant="secondary" className="mt-2">
            Ir a plantillas
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-3">
        Nunca te ha escrito: para iniciar hay que usar una plantilla aprobada.
      </p>
      <select
        value={templateId}
        onChange={(e) => {
          setTemplateId(e.target.value);
          setVars([]);
        }}
        aria-label={t("contacts.templateToStart")}
        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
      >
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.language})
          </option>
        ))}
      </select>

      {elegida && (
        <p className="rounded-md border bg-subtle px-3 py-2 text-[12px] text-text-2">
          {elegida.body}
        </p>
      )}

      {Array.from({ length: nVars }, (_, i) => (
        <Input
          key={i}
          value={vars[i] ?? ""}
          aria-label={`Valor de la variable ${i + 1}`}
          placeholder={`Valor de {{${i + 1}}}`}
          onChange={(e) => {
            const next = [...vars];
            next[i] = e.target.value;
            setVars(next);
          }}
        />
      ))}

      <Button
        size="sm"
        disabled={enviando || !templateId || vars.slice(0, nVars).some((v) => !v?.trim())}
        onClick={() => void enviar()}
      >
        <Send className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.7} />
        {enviando ? "Enviando…" : t("contacts.startConversation")}
      </Button>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </div>
  );
}
