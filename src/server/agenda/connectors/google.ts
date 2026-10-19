import { createHash } from "node:crypto";
import { getEnv } from "@/lib/env";
import {
  ConnectorError,
  type AgendaConnector,
  type MeetingRequest,
  type MeetingResult,
  type TestConnectionResult,
} from "@/server/agenda/connectors/types";
import {
  getCachedGoogleToken,
  setCachedGoogleToken,
  type GoogleCreds,
} from "@/server/agenda/connectors/google-credentials";

/**
 * 015 — Conector Google Calendar + Meet, por REST direto (sem SDK: a
 * constituição não admite dependências novas para isto).
 *
 * Cada agendamento vira um evento da agenda do dono com o seu link
 * do Meet. É o conector com um diferencial claro: o agendamento aparece onde o
 * dono já olha o seu dia.
 *
 * DUAS coisas do Google que dão problemas e aqui estão resolvidas de propósito:
 *
 *  1. **A conferência é criada de forma ASSÍNCRONA.** A resposta imediata de
 *     `events.insert` pode trazer `conferenceData.createRequest.status =
 *     "pending"` e nenhum link. Por isso o evento é relido algumas vezes
 *     antes de desistir; e se mesmo assim não chegou, o agendamento é entregue com o
 *     evento criado e o link pendente (reintentável), nunca duplicando.
 *  2. **O refresh token expira em 7 dias se o app OAuth estiver em modo de
 *     teste.** Isso não se resolve daqui: avisa-se no guia de
 *     conexão, e quando acontece, o 401 marca a credencial como quebrada para
 *     que o dono fique sabendo pela UI e não por um cliente sem link.
 */

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** Quantas vezes o evento é relido aguardando o link do Meet. */
const CONFERENCE_POLLS = 3;
const POLL_DELAY_MS = 400;

/**
 * A chave do cache inclui TUDO o que determina o token.
 *
 * Era `clientId:calendarId`. Como o refresh token e o segredo não entravam,
 * trocar credenciais não tinha efeito observável até que o token expirasse
 * —uma hora— e o operador concluía que as novas também estavam erradas. Aconteceu
 * de verdade: após corrigir o escopo e regenerar o refresh token, o teste
 * continuava devolvendo o MESMO 403, palavra por palavra (#50, ponto 3).
 *
 * Vai como hash e não em texto claro porque essa chave vive na memória do processo e
 * não há motivo para ter um refresh token circulando nela.
 */
function claveDeToken(creds: GoogleCreds): string {
  // `JSON.stringify` do array e não um separador manual: os valores são
  // opacos e uma concatenação crua poderia colidir entre credenciais
  // diferentes. Aqui a ambiguidade quem resolve é o próprio formato.
  return createHash("sha256")
    .update(
      JSON.stringify([
        creds.clientId,
        creds.clientSecret,
        creds.refreshToken,
        creds.calendarId,
      ])
    )
    .digest("hex");
}

async function getAccessToken(creds: GoogleCreds): Promise<string> {
  const key = claveDeToken(creds);
  const cached = getCachedGoogleToken(key);
  if (cached) return cached;

  let res: Response;
  try {
    res = await fetch(`${getEnv().GOOGLE_OAUTH_BASE_URL}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
  } catch (err) {
    throw new ConnectorError("google", `No se pudo contactar a Google: ${err}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ConnectorError(
      "google",
      `Google rechazó el refresh token: ${detail}. Si tu app OAuth sigue en modo prueba, Google lo revoca a los 7 días: publícala en producción y vuelve a conectar.`,
      // `invalid_grant` chega como 400 e significa exatamente isso: é preciso
      // reconectar.
      { status: res.status, isAuthError: res.status === 401 || res.status === 400 }
    );
  }

  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!data?.access_token) {
    throw new ConnectorError("google", "Google no devolvió un token de acceso");
  }
  setCachedGoogleToken(key, data.access_token, data.expires_in ?? 3600);
  return data.access_token;
}

async function googleFetch(
  creds: GoogleCreds,
  path: string,
  init: RequestInit & { allow404?: boolean } = {}
): Promise<unknown> {
  const token = await getAccessToken(creds);
  let res: Response;
  try {
    res = await fetch(`${getEnv().GOOGLE_CAL_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ConnectorError("google", `No se pudo contactar a Google: ${err}`);
  }

  if (res.status === 404 && init.allow404) return null;
  if (res.status === 204) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ConnectorError(
      "google",
      `Google respondió ${res.status}: ${detail}`,
      { status: res.status }
    );
  }
  return await res.json().catch(() => null);
}

type GoogleEvent = {
  id?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
};

/** O link da videochamada, onde quer que o Google o coloque. */
function meetLinkOf(event: GoogleEvent | null): string | null {
  if (!event) return null;
  const video = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video"
  );
  return video?.uri ?? event.hangoutLink ?? null;
}

function eventsPath(creds: GoogleCreds, suffix = ""): string {
  return `/calendars/${encodeURIComponent(creds.calendarId)}/events${suffix}`;
}

export const googleConnector: AgendaConnector<GoogleCreds> = {
  id: "google",
  requiresCredentials: true,

  async createMeeting(creds, req: MeetingRequest): Promise<MeetingResult> {
    const endUtc = new Date(
      Date.parse(req.startUtc) + req.durationMinutes * 60_000
    ).toISOString();

    const created = (await googleFetch(
      creds,
      `${eventsPath(creds)}?conferenceDataVersion=1`,
      {
        method: "POST",
        body: JSON.stringify({
          summary: req.topic,
          description: req.notes ?? undefined,
          start: { dateTime: req.startUtc, timeZone: "UTC" },
          end: { dateTime: endUtc, timeZone: "UTC" },
          conferenceData: {
            createRequest: {
              // O Google exige um id de requisição próprio; o instante o torna
              // único por agendamento sem precisar de aleatoriedade.
              requestId: `vocero-${Date.parse(req.startUtc)}`,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }),
      }
    )) as GoogleEvent | null;

    const eventId = created?.id ?? null;
    if (!eventId) {
      throw new ConnectorError("google", "Google no devolvió el evento creado");
    }

    let link = meetLinkOf(created);
    // A conferência é gerada em segundo plano: a resposta do insert costuma
    // vir `pending`. Relê-se algumas vezes antes de desistir.
    for (let i = 0; i < CONFERENCE_POLLS && !link; i++) {
      await sleep(POLL_DELAY_MS);
      const refreshed = (await googleFetch(
        creds,
        `${eventsPath(creds, `/${encodeURIComponent(eventId)}`)}`
      ).catch(() => null)) as GoogleEvent | null;
      link = meetLinkOf(refreshed);
    }

    // Com o evento criado e sem link, o motor deixa o agendamento "sem link" e
    // o operador tenta de novo: isso relê este mesmo evento, não cria outro.
    return { externalId: eventId, joinUrl: link };
  },

  async refreshMeeting(creds, externalId): Promise<MeetingResult> {
    const event = (await googleFetch(
      creds,
      eventsPath(creds, `/${encodeURIComponent(externalId)}`)
    )) as GoogleEvent | null;
    return { externalId, joinUrl: meetLinkOf(event) };
  },

  async updateMeeting(creds, externalId, req): Promise<void> {
    const endUtc = new Date(
      Date.parse(req.startUtc) + req.durationMinutes * 60_000
    ).toISOString();
    await googleFetch(creds, eventsPath(creds, `/${encodeURIComponent(externalId)}`), {
      method: "PATCH",
      body: JSON.stringify({
        start: { dateTime: req.startUtc, timeZone: "UTC" },
        end: { dateTime: endUtc, timeZone: "UTC" },
      }),
    });
  },

  async deleteMeeting(creds, externalId): Promise<void> {
    await googleFetch(creds, eventsPath(creds, `/${encodeURIComponent(externalId)}`), {
      method: "DELETE",
      allow404: true,
    });
  },

  async testConnection(creds): Promise<TestConnectionResult> {
    try {
      /**
       * Listam-se eventos, não se lê a agenda.
       *
       * `GET /calendars/{id}` é `Calendars.Get`, e o Google só o concede com
       * `calendar.readonly` ou superior. Com o escopo que este conector pede de
       * verdade —`calendar.events`, suficiente para insert/get/patch/delete— a
       * chamada devolve 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT: a conexão
       * funcionava e seu PRÓPRIO teste falhava (#50, ponto 2).
       *
       * Listar um evento entra em `calendar.events`, então o escopo
       * documentado continua sendo o mínimo — que é a razão de pedi-lo.
       */
      const lista = (await googleFetch(
        creds,
        eventsPath(creds, "?maxResults=1")
      )) as { summary?: string } | null;
      // O `summary` da listagem é o nome da agenda: o mesmo dado que
      // se mostrava antes, por uma via que o escopo permite.
      return { ok: true, detail: lista?.summary };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "No se pudo conectar con Google",
      };
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
