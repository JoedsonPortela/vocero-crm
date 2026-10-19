"use client";

import { t } from "@/lib/i18n";
import { AlertTriangle, Cable, Info, Send, Sparkles, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  despachoFallando,
  externalBrainName,
  haceCuanto,
  type BrainDispatchDto,
  type BrainHealthDto,
  type BrainRelayDto,
  type BrainStatusDto,
} from "@/lib/brain-status";
import { cn } from "@/lib/utils";

/**
 * «Quem responde aos seus clientes»: no topo da tela do Agente, porque
 * o interruptor desta página governa só o agente incluído. Um cérebro
 * externo (Nea) responde por conta própria, e com os dois ativos o cliente
 * recebe duas respostas diferentes.
 *
 * 021 — Com o despacho (`BRAIN_DISPATCH_URL`) o CRM repassa cada turno ao
 * cérebro e silencia o agente incluído: a terceira linha diz para quem, quando
 * chegou o último e se algum não chegou.
 */

type Tone = "ok" | "warn" | "off";
type RowView = { tone: Tone; headline: string; detail: string | null };

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  off: "bg-border-strong",
};

export function BrainStatusCard({
  status,
  now = Date.now(),
}: {
  status: BrainStatusDto;
  now?: number;
}) {
  const name = externalBrainName(status);
  const lastSeenAt = status.external.lastSeenAt;

  return (
    <Card data-brain-card data-warning={status.warning ?? "ninguno"}>
      <CardHeader className="pb-4">
        <CardTitle>Quién responde a tus clientes</CardTitle>
        <CardDescription>
          Lo que contesta los WhatsApp de esta instancia. Tiene que ser uno solo:
          si contestan dos, tu cliente recibe dos respuestas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.warning === "doble_respuesta" && (
          <Callout tone="danger" icon={AlertTriangle} title={t("agent.doubleReplyTitle")}>
            El agente incluido y {name ? `tu cerebro externo (${name})` : "tu cerebro externo"}{" "}
            contestan los mismos mensajes: apaga el agente incluido con el interruptor
            de arriba o quita la llave de IA en Ajustes → IA.
          </Callout>
        )}
        {status.warning === "sin_cerebro" && (
          <Callout tone="warning" icon={Info} title={t("agent.nobodyAutoTitle")}>
            Tus clientes solo reciben lo que respondas desde la bandeja: enciende el
            agente incluido (necesita un proveedor de IA en Ajustes → IA) o conecta tu
            cerebro externo con <Env>BOT_API_KEY</Env>.
          </Callout>
        )}

        <dl className="divide-y rounded-md border">
          <BrainRow
            id="embedded"
            icon={Sparkles}
            label="Agente incluido"
            hint={t("agent.inCrmHint")}
            view={embeddedView(status)}
          />
          <BrainRow
            id="external"
            icon={Cable}
            label="Cerebro externo"
            hint="Tu propio bot (Nea u otro) por la API del CRM."
            view={externalView(status, now)}
          />
          {(status.dispatch.host !== null || status.dispatch.problem !== null) && (
            <BrainRow
              id="dispatch"
              icon={Send}
              label="Despacho al cerebro"
              hint={t("agent.dispatchHint")}
              view={dispatchView(status.dispatch, now)}
            />
          )}
        </dl>

        {lastSeenAt && (
          <p className="text-[11px] text-text-3">
            La última llamada del cerebro externo se cuenta desde el último arranque
            del CRM.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function embeddedView(s: BrainStatusDto): RowView {
  const { configured, enabled, answering } = s.embedded;
  const headline = `${enabled ? "Encendido" : "Apagado"} · ${
    configured ? "IA configurada" : "sin proveedor de IA"
  }`;
  // Com o despacho ativo ele não responde, esteja como estiver: vem antes de tudo o
  // resto, para não pedir um provedor de IA que não é necessário.
  if (s.dispatch.active) {
    return {
      tone: "off",
      headline,
      detail: enabled
        ? "En silencio: los turnos se le pasan a tu cerebro externo. Puedes dejarlo apagado."
        : t("agent.keepOffExternal"),
    };
  }
  if (enabled && !configured) {
    return { tone: "warn", headline, detail: t("agent.noReplyMissingProvider") };
  }
  if (answering) {
    return {
      tone: "ok",
      headline,
      detail:
        s.warning === "doble_respuesta"
          ? null
          : "Contesta en las conversaciones con la IA activada.",
    };
  }
  if (s.external.active) {
    return { tone: "off", headline, detail: t("agent.keepOffExternal") };
  }
  return {
    tone: "off",
    headline,
    detail: configured
      ? t("agent.turnOnHint")
      : "Para usarlo, configura tu proveedor de IA en Ajustes → IA.",
  };
}

function externalView(s: BrainStatusDto, now: number): RowView {
  const { keyConfigured, lastSeenAt, active, health } = s.external;
  const llamada = lastSeenAt
    ? `última llamada ${haceCuanto(lastSeenAt, now)}`
    : t("agent.noCallsSinceStart");

  if (health?.reachable) {
    const name = externalBrainName(s);
    const parts = [
      name,
      t("agent.online"),
      health.version && versionLabel(health.version),
      health.mode && `modo ${health.mode}`,
      health.relay && relayLabel(health.relay),
    ].filter(Boolean);
    return keyConfigured
      ? { tone: "ok", headline: capitalize(parts.join(" · ")), detail: `${capitalize(llamada)}.` }
      : {
          tone: "warn",
          headline: capitalize(parts.join(" · ")),
          detail: "Al CRM le falta BOT_API_KEY: no puede contestar por la API.",
        };
  }
  if (health?.problem === "config") {
    return {
      tone: "warn",
      headline: "No se puede consultar su estado",
      detail: `BRAIN_HEALTH_URL no es una URL http:// o https:// válida (p. ej. http://nea:8000/health): corrígela y vuelve a desplegar el CRM.${
        keyConfigured ? ` ${capitalize(llamada)}.` : ""
      }`,
    };
  }
  if (health) {
    const name = externalBrainName(s);
    return {
      tone: "warn",
      headline: capitalize(`${name ? `${name} · ` : ""}no está en línea`),
      detail: `${health.host} ${problemLabel(health)}.${
        keyConfigured ? ` ${capitalize(llamada)}.` : ""
      }`,
    };
  }
  if (keyConfigured) {
    return { tone: active ? "ok" : "off", headline: `Llave configurada · ${llamada}`, detail: null };
  }
  return { tone: "off", headline: "Sin cerebro externo", detail: null };
}

function dispatchView(d: BrainDispatchDto, now: number): RowView {
  const mientras = t("agent.meanwhile");
  if (d.problem === "url") {
    return {
      tone: "warn",
      headline: "No se puede despachar",
      detail: `BRAIN_DISPATCH_URL no es una URL http:// o https:// válida, o lleva usuario y clave (p. ej. http://nea:8000/vocero/dispatch): corrígela y vuelve a desplegar el CRM. ${mientras}`,
    };
  }
  if (d.problem === "sin_llave") {
    return {
      tone: "warn",
      headline: "No se puede despachar",
      detail: `Falta BOT_API_KEY (mínimo 16 caracteres): con ella se firma cada turno y contesta el cerebro. ${mientras}`,
    };
  }
  const espera =
    d.pending > 0
      ? ` ${d.pending === 1 ? "1 turno en espera" : `${d.pending} turnos en espera`}.`
      : "";
  if (d.lastFailure && despachoFallando(d)) {
    return {
      tone: "warn",
      headline: `Activo · ${d.host} · el último turno no llegó`,
      detail: `${capitalize(d.lastFailure.detail)} (${haceCuanto(d.lastFailure.at, now)}). Tras tres intentos fallidos, la conversación queda con una persona.${espera}`,
    };
  }
  return {
    tone: "ok",
    headline: `Activo · ${d.host}`,
    detail: d.lastDeliveredAt
      ? `Último turno entregado ${haceCuanto(d.lastDeliveredAt, now)}.${espera}`
      : `Aún no se ha despachado ningún turno.${espera}`,
  };
}

function versionLabel(v: string): string {
  return /^v/i.test(v) ? v : `v${v}`;
}

function relayLabel(r: BrainRelayDto): string | null {
  if (r.pendientes === null) return null;
  const base = r.pendientes === 1 ? "1 mensaje por relevar" : `${r.pendientes} mensajes por relevar`;
  if (r.pendientes > 0 && r.masViejoSegundos !== null && r.masViejoSegundos >= 60) {
    return `${base} (el más viejo, de hace ${Math.floor(r.masViejoSegundos / 60)} min)`;
  }
  return base;
}

function problemLabel(h: BrainHealthDto): string {
  switch (h.problem) {
    case "timeout":
      return t("agent.noAnswer2s");
    case "status":
      return `respondió ${h.httpStatus ?? "con error"}`;
    case "redirect":
      return t("agent.redirect");
    case "invalid":
      return t("agent.wrongStatus");
    default:
      return t("agent.refusesConnection");
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function BrainRow({
  id,
  icon: Icon,
  label,
  hint,
  view,
}: {
  id: string;
  icon: LucideIcon;
  label: string;
  hint: string;
  view: RowView;
}) {
  return (
    <div
      data-brain-row={id}
      data-tone={view.tone}
      className="grid gap-1.5 p-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:gap-4 sm:p-4"
    >
      <dt className="flex items-start gap-2.5">
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </dt>
      <dd className="flex min-w-0 items-start gap-2 pl-[26px] sm:pl-0">
        <span aria-hidden className={cn("mt-[7px] h-2 w-2 shrink-0 rounded-full", DOT[view.tone])} />
        <div className="min-w-0">
          <p className="break-words text-sm">{view.headline}</p>
          {view.detail && (
            <p className="mt-0.5 break-words text-xs text-muted-foreground">{view.detail}</p>
          )}
        </div>
      </dd>
    </div>
  );
}

function Callout({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: "danger" | "warning";
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-md border p-3",
        tone === "danger"
          ? "border-danger-soft bg-danger-tint text-danger-text"
          : "border-warning-soft bg-warning-tint text-warning-text"
      )}
    >
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} />
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

/** O nome de uma variável, inteiro: quebrado no meio da palavra no celular não
 *  dá para copiar nem reconhecer. */
function Env({ children }: { children: React.ReactNode }) {
  return <code className="whitespace-nowrap font-mono text-[0.92em]">{children}</code>;
}
