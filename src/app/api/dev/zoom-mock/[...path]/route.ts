import { mockGuard } from "@/lib/dev-guard";
import {
  mockCredentialsAreBad,
  resetZoomMock,
  zoomMockSnapshot,
  zoomMockState,
} from "@/server/dev/zoom-mock-state";

export const dynamic = "force-dynamic";

/**
 * 015 — Zoom de mentira para o self-test. Atrás de `mockGuard()`: 404
 * incondicional em produção, indistinguível de uma rota inexistente.
 *
 * Imita o que o conector realmente usa — token, criar, mover, apagar e
 * `users/me` — e ainda expõe `_state` e `_reset` para que o arnês possa
 * afirmar sobre o que recebeu.
 */

type Ctx = { params: Promise<{ path: string[] }> };

const TOKEN = "token-de-mentira-para-el-self-test";

export async function POST(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");

  if (route === "oauth/token") {
    if (mockCredentialsAreBad(req.headers.get("authorization"))) {
      // Igual ao Zoom: o endpoint de token responde 400 quando o segredo não
      // serve.
      return Response.json(
        { reason: "Invalid client_id or client_secret", error: "invalid_client" },
        { status: 400 }
      );
    }
    return Response.json({ access_token: TOKEN, expires_in: 3600 });
  }

  if (route === "_reset") {
    resetZoomMock();
    return Response.json({ ok: true });
  }

  if (route === "users/me/meetings") {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;

    const body = (await req.json().catch(() => ({}))) as {
      topic?: string;
      start_time?: string;
      duration?: number;
      timezone?: string;
    };
    const state = zoomMockState();
    const id = String(90_000_000 + state.nextId++);
    const meeting = {
      id,
      topic: body.topic ?? "",
      startTime: body.start_time ?? "",
      duration: body.duration ?? 0,
      timezone: body.timezone ?? "",
      joinUrl: `https://zoom.mock/j/${id}`,
      updates: 0,
    };
    state.meetings.set(id, meeting);
    return Response.json({ id: Number(id), join_url: meeting.joinUrl }, { status: 201 });
  }

  return new Response(null, { status: 404 });
}

export async function GET(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");

  if (route === "_state") return Response.json(zoomMockSnapshot());

  if (route === "users/me") {
    const unauthorized = requireToken(req);
    if (unauthorized) return unauthorized;
    return Response.json({ id: "u_mock", email: "mock@zoom.test" });
  }

  return new Response(null, { status: 404 });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  const { path } = await ctx.params;
  const id = meetingIdFrom(path);
  const meeting = id ? zoomMockState().meetings.get(id) : undefined;
  if (!meeting) return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    start_time?: string;
    duration?: number;
  };
  // Mesmo id ⇒ mesmo joinUrl: é a mesma reunião, movida de horário.
  if (body.start_time) meeting.startTime = body.start_time;
  if (body.duration) meeting.duration = body.duration;
  meeting.updates += 1;
  return new Response(null, { status: 204 });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const unauthorized = requireToken(req);
  if (unauthorized) return unauthorized;

  const { path } = await ctx.params;
  const id = meetingIdFrom(path);
  const state = zoomMockState();
  if (!id || !state.meetings.has(id)) {
    // O Zoom devolve 404 e o conector trata isso como sucesso.
    return new Response(null, { status: 404 });
  }
  state.meetings.delete(id);
  state.deleted.push(id);
  return new Response(null, { status: 204 });
}

function meetingIdFrom(path: string[]): string | null {
  return path[0] === "meetings" && path[1] ? path[1] : null;
}

function requireToken(req: Request): Response | null {
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${TOKEN}`) return null;
  return Response.json({ code: 124, message: "Invalid access token" }, { status: 401 });
}
