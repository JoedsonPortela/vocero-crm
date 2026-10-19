"use client";

import { t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 016 — Ajustes → Anúncios: conectar el dataset de Meta, decir qué etapa
 * significa "lead calificado" y ver qué se le ha reportado.
 */

type Capi = {
  datasetId: string;
  status: "connected" | "error";
  tokenLast4: string;
  qualifiedStageId: string | null;
};

type Stage = { id: string; name: string; kind: "open" | "won" | "lost" };

type ActivityRow = {
  id: string;
  eventName: string;
  contactName: string | null;
  adHeadline: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
  at: string;
  fbTraceId: string | null;
  error: string | null;
};

const STATUS_LABEL: Record<ActivityRow["status"], string> = {
  sent: "Enviado",
  failed: t("settings.failed"),
  skipped: "Omitido",
  pending: "En curso",
};

const STATUS_VARIANT: Record<
  ActivityRow["status"],
  "success" | "destructive" | "secondary"
> = {
  sent: "success",
  failed: "destructive",
  skipped: "secondary",
  pending: "secondary",
};

/** Qué significa cada evento, en el idioma del negocio y no en el de Meta. */
const EVENT_LABEL: Record<string, string> = {
  QualifiedLead: "Lead calificado",
  Purchase: "Venta",
};

export function AdsClient() {
  const [capi, setCapi] = useState<Capi | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [datasetId, setDatasetId] = useState("");
  const [token, setToken] = useState("");
  const [qualifiedStageId, setQualifiedStageId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadActivity = useCallback(async () => {
    const res = await fetch("/api/settings/capi/events").catch(() => null);
    if (!res?.ok) return setActivity([]);
    const data = (await res.json()) as { events: ActivityRow[] };
    setActivity(data.events);
  }, []);

  useEffect(() => {
    void (async () => {
      const [cfg, stg] = await Promise.all([
        fetch("/api/settings/capi").catch(() => null),
        fetch("/api/pipeline/stages").catch(() => null),
      ]);
      if (cfg?.ok) {
        const data = (await cfg.json()) as { capi: Capi | null };
        setCapi(data.capi);
        setDatasetId(data.capi?.datasetId ?? "");
        setQualifiedStageId(data.capi?.qualifiedStageId ?? "");
      }
      if (stg?.ok) {
        const data = (await stg.json()) as { stages: Stage[] };
        setStages(data.stages);
      }
      await loadActivity();
    })();
  }, [loadActivity]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/settings/capi", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datasetId: datasetId.trim(),
        // Vacío = reusar el token de WhatsApp. Se omite en vez de mandar "".
        ...(token.trim() ? { token: token.trim() } : {}),
        qualifiedStageId: qualifiedStageId || null,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? "Não foi possível salvar");
      return;
    }
    setToken("");
    setSaved(true);
    const cfg = await fetch("/api/settings/capi").catch(() => null);
    if (cfg?.ok) {
      const data = (await cfg.json()) as { capi: Capi | null };
      setCapi(data.capi);
    }
  }

  async function disconnect() {
    setSaving(true);
    await fetch("/api/settings/capi", { method: "DELETE" }).catch(() => null);
    setSaving(false);
    setCapi(null);
    setDatasetId("");
    setToken("");
    setQualifiedStageId("");
    setSaved(false);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Conversões de anúncios</CardTitle>
          <CardDescription>
            A Meta sabe quais conversas começaram a partir de um anúncio, mas não quais deram resultado. Conecte seu dataset e o CRM avisará quando um lead for qualificado e quando a venda for fechada, para que ela otimize para quem compra e não para quem só escreve.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {capi ? (
            <p className="text-sm text-muted-foreground">
              Conectado al dataset{" "}
              <span className="font-medium text-foreground">
                {capi.datasetId}
              </span>{" "}
              · token ····{capi.tokenLast4}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="capi-dataset">ID del dataset</Label>
            <Input
              id="capi-dataset"
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              placeholder="1708105527110154"
            />
            <p className="text-xs text-muted-foreground">
              Gerenciador de Eventos da Meta → seu conjunto de dados. Costuma ser
              o da sua própria conta do WhatsApp.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="capi-token">Token (opcional)</Label>
            <Input
              id="capi-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("settings.reuseWhatsappHint")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              O token da sua conexão do WhatsApp normalmente já consegue publicar no dataset. Cole um novo só se a Meta tiver lhe dado outro diferente.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="capi-stage">{t("settings.capiStage")}</Label>
            <select
              id="capi-stage"
              value={qualifiedStageId}
              onChange={(e) => setQualifiedStageId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="">Não reportar leads qualificados</option>
              {stages
                .filter((s) => s.kind === "open")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <p className="text-xs text-muted-foreground">
              A venda é reportada sozinha quando o negócio entra na sua etapa ganha.
            </p>
          </div>

          {error ? (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p className="text-sm text-success-text">Guardado.</p>
          ) : null}

          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || !datasetId.trim()}>
              {saving ? t("settings.saving") : t("common.save")}
            </Button>
            {capi ? (
              <Button variant="outline" onClick={disconnect} disabled={saving}>
                Desconectar
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Atividade recente</CardTitle>
          <CardDescription>
            O último envio reportado à Meta. Se algo não saiu, aqui aparece o motivo — é a forma de saber se isto funciona, sem sair do CRM.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={() => void loadActivity()}>
            Atualizar
          </Button>
          {activity === null ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ainda não há conversões. Elas aparecerão quando um lead que chegou por um anúncio avançar de etapa.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="kicker text-left">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Evento</th>
                    <th className="py-2 pr-3 font-medium">Contacto</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">{t("settings.thWhen")}</th>
                    <th className="py-2 font-medium">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((row) => (
                    <tr key={row.id} className="border-t align-top">
                      <td className="py-2 pr-3">
                        {EVENT_LABEL[row.eventName] ?? row.eventName}
                        {row.adHeadline ? (
                          <span className="block text-xs text-muted-foreground">
                            {row.adHeadline}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{row.contactName ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS_VARIANT[row.status]}>
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {new Date(row.at).toLocaleString()}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {row.error ?? row.fbTraceId ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
