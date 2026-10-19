import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { estadoIaDe, mensajeDeEstado } from "@/lib/ai/provider";
import { agendaEnabled } from "@/server/agenda/flag";
import { verifyCalendar } from "./calendar-verifiers";

/**
 * O que falta a esta instância para o agente responder (issue #86).
 *
 * Adaptação de `onboarding/status.ts` do Vocero Cloud reduzida ao que a raiz
 * tem: o perfil do agente, a credencial de IA (a linha de Configurações → IA
 * ou, de reserva, `OPENROUTER_*` do ambiente), o número de WhatsApp e, só
 * com `AGENDA=on`, a agenda. Nada de modelo da plataforma, dono convidado,
 * cérebro compartilhado, cobertura nem evidência de teste: aqui uma instância é
 * um negócio e quem a instala é quem a configura.
 *
 * Cada passo sai da MESMA fonte que já decide se essa peça funciona
 * (`estadoIaDe`, o `status` da conexão, o catálogo de conectores): o
 * guia não inventa sua própria noção de «pronto».
 */
export type ReadinessStatus =
  | "ready"
  | "pending"
  | "unsupported"
  | "not_applicable";

export type ReadinessKey = "profile" | "ai" | "whatsapp" | "calendar";

export type ReadinessStep = {
  key: ReadinessKey;
  label: string;
  status: ReadinessStatus;
  /** O que fazer para deixá-lo pronto; em `ready`, o que ficou. */
  nextAction: string;
  href: string | null;
  /**
   * O que está ERRADO, quando não é simplesmente que falte o passo: a chave
   * rejeitada, o token do WhatsApp vencido, um conector sem credencial. O
   * guia o pinta em âmbar abaixo do passo.
   */
  problem: string | null;
};

export type OnboardingStatus = {
  steps: ReadinessStep[];
  /** O agente já está ligado. */
  enabled: boolean;
};

type Db = ReturnType<typeof getDb>;

export async function onboardingStatus(
  organizationId: string,
  db: Db = getDb()
): Promise<OnboardingStatus> {
  const [profile] = await db
    .select({
      name: schema.agentProfile.name,
      instructions: schema.agentProfile.instructions,
      enabled: schema.agentProfile.enabled,
    })
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const [kb] = await db
    .select({ id: schema.kbEntry.id })
    .from(schema.kbEntry)
    .where(scoped(schema.kbEntry.organizationId, organizationId))
    .limit(1);
  const [channel] = await db
    .select({ status: schema.metaCredentials.status })
    .from(schema.metaCredentials)
    .where(scoped(schema.metaCredentials.organizationId, organizationId))
    .limit(1);
  const ia = await estadoIaDe(organizationId);

  const steps: ReadinessStep[] = [
    pasoPerfil(profile, Boolean(kb)),
    {
      key: "ai",
      label: "Proveedor de IA",
      status: ia.activa ? "ready" : "pending",
      nextAction: ia.activa
        ? ia.origen === "org"
          ? "Llave guardada en Ajustes → IA"
          : "Respaldo del entorno (OPENROUTER_*)"
        : "Pega la llave de tu proveedor y elige el modelo en Ajustes → IA",
      href: "/settings/ai",
      // «Sem configurar» é o óbvio do passo; o que é preciso dizer é por
      // que uma chave que o dono JÁ colou não serve.
      problem:
        !ia.activa && ia.motivo !== "sin_configurar"
          ? mensajeDeEstado(ia)
          : null,
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      status: channel?.status === "connected" ? "ready" : "pending",
      nextAction:
        channel?.status === "connected"
          ? "Número conectado"
          : channel
            ? "Vuelve a conectar el número con un token vigente"
            : "Vincular tu número",
      href: "/settings/whatsapp",
      problem:
        channel?.status === "reconnect_required"
          ? "Meta dejó de aceptar el token de WhatsApp: vuelve a conectar el número."
          : null,
    },
  ];

  if (agendaEnabled()) {
    steps.push(await pasoAgenda(organizationId, db));
  } else {
    // Sem a bandeira, a agenda não existe nesta instância (015): o passo se
    // reporta para que o guia saiba que não se aplica, sem link para uma tela
    // que responderia 404.
    steps.push({
      key: "calendar",
      label: "Agenda",
      status: "not_applicable",
      nextAction:
        "La agenda no está encendida en esta instancia (variable AGENDA).",
      href: null,
      problem: null,
    });
  }

  return { steps, enabled: profile?.enabled ?? false };
}

type Perfil = { name: string; instructions: string | null; enabled: boolean };

/**
 * O agente está «configurado» quando tem com que responder: instruções
 * ou conhecimento. O nome vem com padrão («Assistente»), então não é
 * o que distingue um perfil trabalhado de um recém-semeado.
 */
function pasoPerfil(profile: Perfil | undefined, hayConocimiento: boolean): ReadinessStep {
  const listo =
    Boolean(profile?.name.trim()) &&
    (Boolean(profile?.instructions?.trim()) || hayConocimiento);
  return {
    key: "profile",
    label: "Configuración del agente",
    status: listo ? "ready" : "pending",
    nextAction: listo
      ? "Nombre, instrucciones y conocimiento revisados"
      : "Dale un nombre y escribe sus instrucciones o carga conocimiento del negocio",
    href: "/agent",
    problem: null,
  };
}

async function pasoAgenda(organizationId: string, db: Db): Promise<ReadinessStep> {
  const [settings] = await db
    .select({
      connector: schema.calendarSettings.connector,
      weeklyHours: schema.calendarSettings.weeklyHours,
    })
    .from(schema.calendarSettings)
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  const [zoom] = await db
    .select({ status: schema.zoomCredentials.status })
    .from(schema.zoomCredentials)
    .where(scoped(schema.zoomCredentials.organizationId, organizationId))
    .limit(1);
  const [google] = await db
    .select({ status: schema.googleCredentials.status })
    .from(schema.googleCredentials)
    .where(scoped(schema.googleCredentials.organizationId, organizationId))
    .limit(1);

  const status = verifyCalendar(settings, {
    zoom: zoom?.status === "connected",
    google: google?.status === "connected",
  });

  let problem: string | null = null;
  if (status === "unsupported") {
    problem = `El conector «${settings?.connector}» no existe en esta instancia: elige otro en Ajustes → Agenda.`;
  } else if (status === "pending" && settings && settings.connector !== "enlace-fijo") {
    const nombre = settings.connector === "zoom" ? "Zoom" : "Google";
    const cred = settings.connector === "zoom" ? zoom : google;
    problem = cred
      ? `${nombre} rechazó la credencial guardada: vuelve a conectarlo en Ajustes → Agenda.`
      : `Elegiste ${nombre} pero no está conectado: pega sus credenciales en Ajustes → Agenda.`;
  }

  return {
    key: "calendar",
    label: "Agenda",
    status,
    nextAction:
      status === "ready"
        ? "Horarios y conector listos"
        : "Guarda tus horarios y cómo se entrega la reunión en Ajustes → Agenda",
    href: "/settings/calendar",
    problem,
  };
}
