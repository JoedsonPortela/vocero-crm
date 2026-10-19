import type { SessionContext } from "@/lib/auth/session";
import { canConfigure } from "@/lib/auth/roles";
import {
  onboardingStatus,
  type OnboardingStatus,
  type ReadinessStep,
} from "./status";

/**
 * O guia de início: três passos (quatro com a agenda) e nada mais (issue #86).
 *
 * É o primeiro que vê quem instala o Vocero: configurar o agente, vincular
 * o provedor de IA, conectar o número e, se a agenda existir nesta
 * instância, deixá-la pronta. Ao terminar, um botão liga o agente. O
 * resto —a Caixa de entrada, o Pipeline— já está no menu; o guia não o repete.
 *
 * O estado de cada passo sai de `onboardingStatus`, a mesma fonte que já
 * verifica cada conexão: o guia não inventa sua própria noção de «pronto».
 * Adaptação de `onboarding/guide.ts` do Vocero Cloud sem o que lá é da
 * plataforma (modelo fixado pelo suporte, agências, planos).
 */
export type GuideStep = {
  key: "agent" | "ai" | "whatsapp" | "calendar";
  title: string;
  description: string;
  done: boolean;
  href: string;
  cta: string;
  /** O que falta, quando não é o óbvio do passo. */
  hint: string | null;
};

export type Guide = {
  steps: GuideStep[];
  complete: boolean;
  /** O agente já está ligado. */
  enabled: boolean;
};

const ready = (s: ReadinessStep | undefined) => s?.status === "ready";

/** Pura: dos passos verificados aos do guia. */
export function guideFrom(status: OnboardingStatus): Guide {
  const step = (key: ReadinessStep["key"]) =>
    status.steps.find((s) => s.key === key);
  const profile = step("profile");
  const ai = step("ai");
  const whatsapp = step("whatsapp");
  const calendar = step("calendar");

  const steps: GuideStep[] = [
    {
      key: "agent",
      title: "Configura tu agente",
      description:
        "Ponle nombre y cuéntale a qué se dedica tu negocio. Si quieres ver un ejemplo primero, carga la demo desde la Bandeja y cámbiala por tus datos.",
      done: ready(profile),
      href: "/agent",
      cta: "Ir a Agente",
      hint: ready(profile) ? null : (profile?.nextAction ?? null),
    },
    {
      key: "ai",
      title: "Vincula tu proveedor de IA",
      description:
        "Es la cuenta con la que tu agente piensa: OpenRouter o cualquier proveedor compatible con la API de OpenAI. La creas y la pagas tú; aquí solo pegas la llave y eliges el modelo.",
      done: ready(ai),
      href: "/settings/ai",
      cta: "Vincular proveedor",
      hint: ai?.problem ?? null,
    },
    {
      key: "whatsapp",
      title: "Vincula tu número de WhatsApp",
      description:
        "Conecta el número donde te escriben tus clientes. El CRM registra el webhook en Meta por ti al guardar.",
      done: ready(whatsapp),
      href: "/settings/whatsapp",
      cta: "Conectar WhatsApp",
      hint: whatsapp?.problem ?? null,
    },
  ];
  // Sem agenda nesta instância o passo não existe: pintá-lo como «não se aplica»
  // seria justamente o tipo de ruído que o guia evita.
  if (calendar && calendar.status !== "not_applicable") {
    steps.push({
      key: "calendar",
      title: "Configura tu agenda",
      description:
        "Define tus horarios y cómo se entrega la reunión para que tu agente pueda agendar por ti.",
      done: ready(calendar),
      href: "/settings/calendar",
      cta: "Configurar agenda",
      hint: calendar.problem,
    });
  }
  return { steps, complete: steps.every((s) => s.done), enabled: status.enabled };
}

export async function guideStatus(organizationId: string): Promise<Guide> {
  return guideFrom(await onboardingStatus(organizationId));
}

/**
 * O guia é a primeira coisa que esta pessoa vê ao entrar?
 *
 * Só para quem pode configurar (um membro da equipe não pode fazer nenhum
 * dos passos) e só enquanto faltar algo: com todos os passos prontos e o
 * agente ligado entra-se direto na Caixa de entrada, como sempre.
 *
 * Um negócio demo recém-semeado («Ferretería El Martillo») passa por aqui
 * igual: o seed deixa o agente configurado (passo 1 pronto), mas não pode
 * vincular uma chave de IA nem um número, e sem isso o agente não responde.
 * Capturar `/` não prende ninguém: o menu leva a qualquer tela.
 */
export async function guideFirst(
  session: Pick<SessionContext, "organizationId" | "role">
): Promise<boolean> {
  if (!canConfigure(session.role)) return false;
  const guide = await guideStatus(session.organizationId);
  return !guide.complete || !guide.enabled;
}
