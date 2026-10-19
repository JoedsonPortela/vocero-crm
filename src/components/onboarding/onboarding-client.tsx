"use client";

import { t } from "@/lib/i18n";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Power } from "lucide-react";
import type { Guide } from "@/server/onboarding/guide";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * La primera pantalla (issue #86): los pasos con su avance y, al final, el
 * botón que enciende el agente. Todo lo que afirma viene del servidor
 * (`guide`); aquí solo se pinta y se enciende.
 */
export function OnboardingClient({
  guide,
  agentName,
}: {
  guide: Guide;
  agentName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const total = guide.steps.length;
  const done = guide.steps.filter((s) => s.done).length;
  const current = guide.steps.find((s) => !s.done)?.key ?? null;
  // Antes del paso 1 el nombre es el de fábrica («Asistente») y se lee como
  // una palabra suelta, no como el nombre de alguien: se dice «tu agente».
  const agentReady = guide.steps.find((s) => s.key === "agent")?.done ?? false;
  const agente = (agentReady && agentName) || "tu agente";

  async function encender() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/agent/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => null);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(
        data?.error?.message ?? t("onboarding.failedAgent")
      );
      setBusy(false);
      return;
    }
    router.refresh();
    setBusy(false);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Guía de inicio
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            Deja listo tu CRM en {total} pasos
          </h1>
          <p className="mt-2 text-muted-foreground">
            Hazlos en orden: cada botón te lleva a la pantalla que toca. Al
            volver aquí verás tu avance.
          </p>
        </header>

        <div aria-label={t("onboarding.progress")}>
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {done} de {total} listos
            </span>
            {guide.complete && <span className="text-success-text">¡Completo!</span>}
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
        </div>

        <ol className="space-y-3">
          {guide.steps.map((step, i) => {
            const isCurrent = step.key === current;
            return (
              <li
                key={step.key}
                className={cn(
                  "flex gap-4 rounded-xl border bg-card p-4 sm:p-5",
                  isCurrent && "border-primary ring-[3px] ring-brand-soft"
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                    // Verde de estado con su propio texto: legible en los dos
                    // temas sin un blanco cableado.
                    step.done
                      ? "bg-success-tint text-success-text"
                      : isCurrent
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {step.done ? <Check className="h-4 w-4" strokeWidth={2.5} /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">
                    {step.title}
                    <span className="sr-only">{step.done ? " (listo)" : " (pendiente)"}</span>
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
                  {!step.done && step.hint && (
                    <p className="mt-1 text-sm text-warning-text">{step.hint}</p>
                  )}
                  <div className="mt-3">
                    {step.done ? (
                      <Link
                        href={step.href}
                        className="text-sm text-muted-foreground underline underline-offset-2"
                      >
                        Listo · revisar
                      </Link>
                    ) : (
                      <Link
                        href={step.href}
                        className={buttonVariants({
                          size: "sm",
                          variant: isCurrent ? "default" : "outline",
                        })}
                      >
                        {step.cta}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <section
          className={cn(
            "rounded-xl border p-5",
            guide.complete && !guide.enabled ? "border-primary bg-brand-tint" : "bg-card"
          )}
        >
          {guide.enabled ? (
            <>
              <h2 className="font-semibold">
                {agentReady && agentName
                  ? `${agentName} ya está contestando`
                  : t("onboarding.agentAnswering")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                El agente está encendido y atiende a tus clientes por WhatsApp.
                Puedes apagarlo cuando quieras desde Agente.
              </p>
              <Link href="/inbox" className={cn(buttonVariants({ size: "sm" }), "mt-3")}>
                Ir a la Bandeja <ArrowRight className="h-4 w-4" />
              </Link>
            </>
          ) : guide.complete ? (
            <>
              <h2 className="font-semibold">¡Todo listo! Enciende a {agente}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Desde ese momento contestará a tus clientes por WhatsApp. Puedes
                apagarlo cuando quieras desde Agente.
              </p>
              <Button className="mt-3" disabled={busy} onClick={() => void encender()}>
                <Power className="h-4 w-4" />
                {busy ? "Encendiendo…" : `Encender a ${agente}`}
              </Button>
              {error && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {error}
                </p>
              )}
            </>
          ) : (
            <>
              <h2 className="flex items-center gap-2 font-semibold">
                <Power className="h-4 w-4 text-muted-foreground" />
                Al final: encender a {agente}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Tu agente empieza apagado: mientras no lo enciendas no le
                contesta a nadie y los mensajes que lleguen los atiendes tú desde
                la Bandeja. Cuando completes los {total} pasos, aquí aparece el
                botón para encenderlo.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
