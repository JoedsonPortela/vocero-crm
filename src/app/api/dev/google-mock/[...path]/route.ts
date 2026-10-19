import { mockGuard } from "@/lib/dev-guard";
import {
  googleMockSnapshot,
  googleMockState,
  mockRefreshTokenIsBad,
  resetGoogleMock,
} from "@/server/dev/google-mock-state";

export const dynamic = "force-dynamic";

/**
 * 015 — Google de mentira para o self-test, atrás de `mockGuard()` (404
 * incondicional em produção).
 *
 * Cobre o que o conector usa: renovar o token, criar/ler/mover/apagar um
 * evento e ler o calendário. E reproduz a assincronia da conferência:
 * ao criar NÃO há link do Meet, e ele aparece numa leitura posterior.
 */

type Ctx = { params: Promise<{ path: string[] }> };

const TOKEN = "google-token-de-mentira";

export async function POST(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");

  if (route === "token") {
    const body = await req.text();
    if (mockRefreshTokenIsBad(body)) {
      return Response.json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        { status: 400 }
      );
    }
    return Response.json({ access_token: TOKEN, expires_in: 3600 });
  }

  if (route === "_reset") {
    resetGoogleMock();
    return Response.json({ ok: true });
  }

  // POST /calendars/{id}/events
  if (path[0] === "calendars" && path[2] === "events" && path.length === 3) {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;

    const body = (await req.json().catch(() => ({}))) as {
      summary?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
    };
    const state = googleMockState();
    const id = `evt_${state.nextId++}`;
    state.events.set(id, {
      id,
      summary: body.summary ?? "",
      start: body.start?.dateTime ?? "",
      end: body.end?.dateTime ?? "",
      reads: 0,
      meetLink: null,
      updates: 0,
    });
    // Sem link ainda: a conferência está sendo criada. É o
    // comportamento real do Google e por isso o conector relê.
    return Response.json({
      id,
      summary: body.summary,
      conferenceData: { createRequest: { status: { statusCode: "pending" } } },
    });
  }

  return new Response(null, { status: 404 });
}

export async function GET(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;

  if (path.join("/") === "_state") return Response.json(googleMockSnapshot());

  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  // GET /calendars/{id} — o teste de conexão.
  if (path[0] === "calendars" && path.length === 2) {
    return Response.json({ id: path[1], summary: "Calendario de prueba" });
  }

  // GET /calendars/{id}/events/{eventId}
  const event = eventFrom(path);
  if (!event) return new Response(null, { status: 404 });

  const state = googleMockState();
  event.reads += 1;
  if (!event.meetLink && event.reads > state.conferenceDelayReads) {
    event.meetLink = `https://meet.google.mock/${event.id}`;
  }

  return Response.json({
    id: event.id,
    summary: event.summary,
    conferenceData: event.meetLink
      ? {
          createRequest: { status: { statusCode: "success" } },
          entryPoints: [{ entryPointType: "video", uri: event.meetLink }],
        }
      : { createRequest: { status: { statusCode: "pending" } } },
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  const { path } = await ctx.params;
  const event = eventFrom(path);
  if (!event) return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  };
  if (body.start?.dateTime) event.start = body.start.dateTime;
  if (body.end?.dateTime) event.end = body.end.dateTime;
  event.updates += 1;
  // O evento foi movido: o link do Meet é o mesmo.
  return Response.json({ id: event.id });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  const { path } = await ctx.params;
  const event = eventFrom(path);
  if (!event) return new Response(null, { status: 404 });

  const state = googleMockState();
  state.events.delete(event.id);
  state.deleted.push(event.id);
  return new Response(null, { status: 204 });
}

function eventFrom(path: string[]) {
  if (path[0] !== "calendars" || path[2] !== "events" || !path[3]) return null;
  return googleMockState().events.get(path[3]) ?? null;
}

function requireToken(req: Request): Response | null {
  if (req.headers.get("authorization") === `Bearer ${TOKEN}`) return null;
  return Response.json(
    { error: { code: 401, message: "Invalid Credentials" } },
    { status: 401 }
  );
}
