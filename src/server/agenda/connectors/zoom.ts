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
  getCachedZoomToken,
  setCachedZoomToken,
  type ZoomCreds,
} from "@/server/agenda/connectors/zoom-credentials";

/**
 * 015 — Conector Zoom (Server-to-Server OAuth).
 *
 * É o conector de referência: sua forma exata está há meses em produção num
 * CRM real, e o contrato dos conectores foi medido a partir deste uso.
 *
 * Fronteira única de saída para o Zoom: fora deste arquivo, ninguém sabe que
 * o Zoom existe.
 */

/**
 * Os QUATRO escopos granulares necessários. `user:read:user` é o que se
 * esquece —é usado pelo teste de conexão— e sem ele conectar falha mesmo que as
 * credenciais sirvam para criar reuniões.
 */
export const ZOOM_SCOPES = [
  "meeting:write:meeting",
  "meeting:update:meeting",
  "meeting:delete:meeting",
  "user:read:user",
] as const;

/**
 * A chave do cache inclui TUDO o que determina o token.
 *
 * A mesma armadilha do Google (#50, ponto 3), que aqui ninguém reportou
 * ainda porque o conector é usado menos: era `accountId:clientId`, então
 * trocar o SEGREDO não tinha efeito observável até que o token expirasse e
 * o operador concluísse que as credenciais novas também estavam erradas.
 *
 * Corrige-se junto com a outra de propósito: deixar uma das duas cópias do
 * mesmo erro é como ele volta.
 */
function claveDeToken(creds: ZoomCreds): string {
  return createHash("sha256")
    .update(JSON.stringify([creds.accountId, creds.clientId, creds.clientSecret]))
    .digest("hex");
}

async function getAccessToken(creds: ZoomCreds): Promise<string> {
  const key = claveDeToken(creds);
  const cached = getCachedZoomToken(key);
  if (cached) return cached;

  const base = getEnv().ZOOM_OAUTH_BASE_URL;
  const url = `${base}/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(
    creds.accountId
  )}`;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString(
    "base64"
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}` },
    });
  } catch (err) {
    throw new ConnectorError("zoom", `No se pudo contactar a Zoom: ${err}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ConnectorError("zoom", `Zoom rechazó las credenciales: ${detail}`, {
      status: res.status,
      // O endpoint de token responde 400 quando as credenciais não servem:
      // aqui um 400 É um problema de autenticação, diferente do resto
      // da API, onde costuma ser uma validação do corpo.
      isAuthError: res.status === 401 || res.status === 400,
    });
  }

  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!data?.access_token) {
    throw new ConnectorError("zoom", "Zoom no devolvió un token de acceso");
  }
  setCachedZoomToken(key, data.access_token, data.expires_in ?? 3600);
  return data.access_token;
}

async function zoomFetch(
  creds: ZoomCreds,
  path: string,
  init: RequestInit & { allow404?: boolean } = {}
): Promise<unknown> {
  const token = await getAccessToken(creds);
  const url = `${getEnv().ZOOM_BASE_URL}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ConnectorError("zoom", `No se pudo contactar a Zoom: ${err}`);
  }

  // Idempotência: apagar algo que já não está é objetivo cumprido.
  if (res.status === 404 && init.allow404) return null;
  if (res.status === 204) return null;

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ConnectorError("zoom", `Zoom respondió ${res.status}: ${detail}`, {
      status: res.status,
    });
  }
  return await res.json().catch(() => null);
}

export const zoomConnector: AgendaConnector<ZoomCreds> = {
  id: "zoom",
  requiresCredentials: true,

  async createMeeting(creds, req: MeetingRequest): Promise<MeetingResult> {
    const data = (await zoomFetch(creds, "/users/me/meetings", {
      method: "POST",
      body: JSON.stringify({
        topic: req.topic,
        type: 2, // reunião agendada
        // O Zoom rejeita os milissegundos em start_time.
        start_time: req.startUtc.replace(/\.\d{3}Z$/, "Z"),
        duration: req.durationMinutes,
        timezone: req.timezone,
        agenda: req.notes ?? undefined,
        settings: { join_before_host: true, waiting_room: false },
      }),
    })) as { id?: number | string; join_url?: string } | null;

    if (!data?.id || !data.join_url) {
      throw new ConnectorError("zoom", "Zoom no devolvió la reunión creada");
    }
    return { externalId: String(data.id), joinUrl: data.join_url };
  },

  async updateMeeting(creds, externalId, req): Promise<void> {
    // Só a hora: o mesmo id conserva o mesmo join_url, que é o que o
    // cliente já tem guardado.
    await zoomFetch(creds, `/meetings/${encodeURIComponent(externalId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        start_time: req.startUtc.replace(/\.\d{3}Z$/, "Z"),
        duration: req.durationMinutes,
        timezone: req.timezone,
      }),
    });
  },

  async deleteMeeting(creds, externalId): Promise<void> {
    await zoomFetch(creds, `/meetings/${encodeURIComponent(externalId)}`, {
      method: "DELETE",
      allow404: true,
    });
  },

  async testConnection(creds): Promise<TestConnectionResult> {
    try {
      const me = (await zoomFetch(creds, "/users/me")) as {
        email?: string;
      } | null;
      return { ok: true, detail: me?.email };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "No se pudo conectar con Zoom",
      };
    }
  },
};
