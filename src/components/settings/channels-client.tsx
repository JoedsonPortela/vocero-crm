"use client";

import { t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, RefreshCw } from "lucide-react";
import { ChannelBadge } from "@/components/channel-badge";
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
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { cn } from "@/lib/utils";

/**
 * 023 — Ajustes → Canales → Estado.
 *
 * Una fila por canal encendido con las tres cosas que alguien pregunta cuando
 * «no me llegan los mensajes»: ¿está conectado?, ¿cuándo entró el último? y,
 * si llega por Zernio, ¿siguen bien la cuenta y el webhook? La salud se le
 * pregunta a Zernio al abrir la pantalla; nada de esto se guarda.
 */

type Level = "ok" | "warn" | "error";
type Health = { level: Level; message: string };

type Row = {
  channel: Channel;
  connected: boolean;
  source: "meta" | "zernio" | null;
  account: string | null;
  status: "connected" | "reconnect_required" | null;
  lastInboundAt: string | null;
  health: {
    account: Health;
    webhook: Health & { lastFiredAt: string | null; failureCount: number };
  } | null;
};

const SETTINGS_HREF: Record<Channel, string> = {
  whatsapp: "/settings/whatsapp",
  instagram: "/settings/instagram",
  messenger: "/settings/messenger",
  tiktok: "/settings/tiktok",
};

const DOT: Record<Level, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
};

/** «hace 5 min», «hace 3 h», «hace 2 días». */
function hace(iso: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

function fecha(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

export function ChannelsClient() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // La hora se fija al cargar: leer el reloj durante el render hace que el
  // servidor y el navegador pinten textos distintos.
  const [now, setNow] = useState(0);

  const refetch = useCallback(async () => {
    setLoading(true);
    const data = await fetch("/api/settings/channels")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    setLoading(false);
    setNow(Date.now());
    if (!data) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setRows(data.channels);
    setCanManage(Boolean(data.canManage));
  }, []);

  useEffect(() => {
    void refetch();
    // La URL para quien prefiera crear el webhook a mano en Zernio: cualquiera
    // de las tres sirve, porque el CRM reparte por red.
    void fetch("/api/settings/webhook")
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => setWebhookUrl(w?.instagramUrl ?? w?.messengerUrl ?? w?.tiktokUrl ?? null))
      .catch(() => null);
  }, [refetch]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // sin portapapeles (contexto no seguro): el texto sigue visible
    }
  }

  async function repair() {
    setRepairing(true);
    setNotice(null);
    const res = await fetch("/api/settings/channels", { method: "POST" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as {
      created?: boolean;
      accounts?: number;
      error?: { message?: string };
    } | null;
    setRepairing(false);
    if (!res?.ok) {
      setNotice({
        ok: false,
        text: data?.error?.message ?? "Não foi possível cadastrar o webhook. Tente novamente.",
      });
      return;
    }
    const cuentas = data?.accounts === 1 ? "sua conta conectada" : `suas ${data?.accounts} contas conectadas`;
    setNotice({
      ok: true,
      text: data?.created
        ? `Webhook dado de alta en Zernio, limitado a ${cuentas}.`
        : `Webhook actualizado en Zernio y limitado a ${cuentas}.`,
    });
    void refetch();
  }

  if (!rows) {
    return (
      <p className="text-sm text-muted-foreground">
        {failed ? "Não foi possível carregar o status dos canais." : "Carregando…"}
      </p>
    );
  }

  const porZernio = rows.filter((r) => r.source === "zernio");
  const webhookMal = porZernio.some((r) => r.health && r.health.webhook.level === "error");

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Status dos canais</CardTitle>
            <CardDescription>
              Os canais ativos nesta instância: se estão conectados, quando chegou a última mensagem de um cliente e, se chegam pelo Zernio, como estão a conta e o webhook.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void refetch()}
            className="shrink-0"
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            Actualizar
          </Button>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {rows.map((r) => (
            <div key={r.channel} data-channel={r.channel} className="space-y-2 px-6 py-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <ChannelBadge channel={r.channel} className="h-6 w-6" />
                <span className="text-[14.5px] font-bold">{CHANNEL_LABEL[r.channel]}</span>
                <Estado row={r} />
                <Link
                  href={SETTINGS_HREF[r.channel]}
                  className="ml-auto text-xs font-semibold text-brand-text underline-offset-2 hover:underline"
                >
                  {r.connected ? "Configurar" : "Conectar"}
                </Link>
              </div>

              {r.connected && (
                <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[9.5rem_1fr]">
                  <dt className="text-text-2">Cuenta</dt>
                  <dd>
                    {r.account ?? "Sem nome"}
                    {r.channel !== "whatsapp" && (
                      <span className="text-text-2">
                        {" "}
                        · {r.source === "zernio" ? "por Zernio" : "app propia de Meta"}
                      </span>
                    )}
                  </dd>

                  <dt className="text-text-2">Último mensaje</dt>
                  <dd>
                    {r.lastInboundAt ? (
                      <>
                        {hace(r.lastInboundAt, now)}
                        <span className="text-text-2"> · {fecha(r.lastInboundAt)}</span>
                      </>
                    ) : (
                      <span className="text-text-2">{t("settings.noChannelYet")}</span>
                    )}
                  </dd>

                  {r.health && (
                    <>
                      <dt className="text-text-2">Cuenta en Zernio</dt>
                      <dd>
                        <Salud health={r.health.account} />
                      </dd>
                      <dt className="text-text-2">Webhook do Zernio</dt>
                      <dd>
                        <Salud health={r.health.webhook} />
                        {r.health.webhook.lastFiredAt && (
                          <span className="text-text-2">
                            {" "}
                            · último aviso {hace(r.health.webhook.lastFiredAt, now)}
                          </span>
                        )}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {porZernio.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Webhook do Zernio</CardTitle>
            <CardDescription>
              É o aviso pelo qual o Zernio entrega cada mensagem a esta
              instância. O Vocero o cadastra ao conectar um canal, com o evento{" "}
              <code>message.received</code> e limitado às suas contas conectadas.
              Se foi desativado ou ficou sem uma conta, é reparado aqui.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {canManage ? (
              <Button
                variant={webhookMal ? "default" : "outline"}
                disabled={repairing}
                onClick={() => void repair()}
              >
                {repairing
                  ? "Hablando con Zernio…"
                  : webhookMal
                    ? "Reparar o webhook no Zernio"
                    : "Cadastrar o webhook novamente"}
              </Button>
            ) : (
              <p className="text-sm text-text-2">
                Somente o proprietário pode alterar o webhook.
              </p>
            )}
            {notice && (
              <p
                role="status"
                className={cn("text-sm", notice.ok ? "text-success-text" : "text-destructive")}
              >
                {notice.text}
              </p>
            )}
            {webhookUrl && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs font-semibold text-text-2">
                  Crearlo a mano en Zernio
                </summary>
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-text-2">
                    No Zernio → Webhooks, cadastre esta URL com o evento{" "}
                    <code>message.received</code> e limite-o às suas contas. O
                    secreto de firma lo lee Vocero de Zernio: no hay que
                    copiá-lo aqui.
                  </p>
                  <div className="flex gap-2">
                    <Input readOnly value={webhookUrl} className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={t("settings.copyUrl")}
                      onClick={() => void copy(webhookUrl)}
                    >
                      {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * El distintivo dice lo peor que le pasa al canal: «Conectado» en verde encima
 * de una cuenta que Zernio pide reconectar sería la pantalla mintiendo.
 */
function Estado({ row }: { row: Row }) {
  if (!row.connected) return <Badge variant="secondary">Não conectado</Badge>;
  if (row.status === "reconnect_required") {
    return <Badge variant="destructive">É preciso reconectar</Badge>;
  }
  const niveles = row.health ? [row.health.account.level, row.health.webhook.level] : [];
  if (niveles.includes("error")) return <Badge variant="destructive">Con problemas</Badge>;
  if (niveles.includes("warn")) return <Badge variant="warning">Revisar</Badge>;
  return <Badge variant="success">Conectado</Badge>;
}

function Salud({ health }: { health: Health }) {
  return (
    <span className="inline-flex items-start gap-2">
      <span
        aria-hidden
        className={cn("mt-[0.45em] h-2 w-2 shrink-0 rounded-full", DOT[health.level])}
      />
      <span>{health.message}</span>
    </span>
  );
}
