import { mockGuard } from "@/lib/dev-guard";
import {
  nextZernioMessageId,
  resetZernioMock,
  zernioMockState,
  zernioTokenIsBad,
  type ZernioMockAccount,
  type ZernioMockWebhook,
} from "@/server/dev/zernio-mock-state";

export const dynamic = "force-dynamic";

/**
 * 017 — Zernio de mentira para o self-test. Atrás de `mockGuard()`: 404
 * incondicional em produção, indistinguível de uma rota inexistente.
 *
 * Imita apenas o que o Vocero usa dessa API — listar conversas, responder
 * em uma e, desde a 023, as contas e os webhooks — e expõe `_sent`,
 * `_state`, `_accounts`, `_webhooks`, `_down` e `_reset` para que o arnês
 * prepare o cenário e afirme sobre o que aconteceu.
 */

type Ctx = { params: Promise<{ path: string[] }> };

function unauthorized(): Response {
  return Response.json(
    { error: { message: "Invalid API key" } },
    { status: 401 }
  );
}

function unavailable(): Response {
  return Response.json({ error: { message: "Service unavailable" } }, { status: 503 });
}

/** Aplica ao webhook só os campos que chegaram, como faz a API real. */
function webhookFrom(
  body: Record<string, unknown>,
  base: ZernioMockWebhook
): ZernioMockWebhook {
  return {
    ...base,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.url === "string" ? { url: body.url } : {}),
    ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
    ...(Array.isArray(body.events) ? { events: body.events.map(String) } : {}),
    ...(typeof body.isActive === "boolean" ? { isActive: body.isActive } : {}),
    ...(Array.isArray(body.accountIds) ? { accountIds: body.accountIds.map(String) } : {}),
  };
}

export async function GET(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  const route = path.join("/");

  const state = zernioMockState();
  if (route === "_sent") {
    return Response.json({ sent: state.sent });
  }
  if (route === "_state") {
    return Response.json({
      accounts: state.accounts,
      webhooks: state.webhooks,
      hits: state.hits,
    });
  }
  if (zernioTokenIsBad(req.headers.get("authorization"))) return unauthorized();
  state.hits[route] = (state.hits[route] ?? 0) + 1;
  if (state.down.includes(route)) return unavailable();

  // 023 — GET /accounts: valida a chave e informa quais contas ela tem.
  if (route === "accounts") {
    return Response.json({ accounts: state.accounts, hasAnalyticsAccess: false });
  }
  // 023 — GET /webhooks/settings: os webhooks da chave, com o seu segredo.
  if (route === "webhooks/settings") {
    return Response.json({ webhooks: state.webhooks });
  }

  // GET /inbox/conversations → o que a validação da chave usa.
  if (route === "inbox/conversations") {
    return Response.json({ data: [], hasMore: false });
  }
  return Response.json({});
}

export async function POST(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;

  const route = path.join("/");
  if (route === "_reset") {
    resetZernioMock();
    return Response.json({ ok: true });
  }
  // 023 — preparar o cenário a partir do arnês.
  if (route === "_accounts" || route === "_webhooks" || route === "_down") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const state = zernioMockState();
    if (route === "_accounts") {
      state.accounts = (body.accounts as ZernioMockAccount[] | undefined) ?? [];
    } else if (route === "_webhooks") {
      state.webhooks = (body.webhooks as ZernioMockWebhook[] | undefined) ?? [];
    } else {
      state.down = (body.routes as string[] | undefined) ?? [];
    }
    return Response.json({ ok: true });
  }
  if (zernioTokenIsBad(req.headers.get("authorization"))) return unauthorized();
  if (zernioMockState().down.includes(route)) return unavailable();

  // 023 — POST /webhooks/settings: criar.
  if (route === "webhooks/settings") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const state = zernioMockState();
    const webhook = webhookFrom(body, {
      _id: `whmock_${Date.now().toString(36)}_${++state.seq}`,
      name: "",
      url: "",
      secret: null,
      events: [],
      isActive: true,
      accountIds: [],
      failureCount: 0,
      lastFiredAt: null,
    });
    state.webhooks.push(webhook);
    return Response.json({ success: true, webhook });
  }

  // POST /inbox/conversations/{id}/messages
  if (
    path.length === 4 &&
    path[0] === "inbox" &&
    path[1] === "conversations" &&
    path[3] === "messages"
  ) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const state = zernioMockState();
    const id = nextZernioMessageId();
    state.sent.push({
      n: state.seq,
      conversationId: decodeURIComponent(path[2]!),
      accountId: body.accountId ? String(body.accountId) : null,
      message: String(body.message ?? ""),
      ...(body.messagingType ? { messagingType: String(body.messagingType) } : {}),
      ...(body.messageTag ? { messageTag: String(body.messageTag) } : {}),
      idempotencyKey: req.headers.get("idempotency-key"),
      at: new Date().toISOString(),
    });
    return Response.json({ message: { id } });
  }

  return Response.json({});
}

/** 023 — PUT /webhooks/settings: atualizar o webhook `webhookId`. */
export async function PUT(req: Request, ctx: Ctx) {
  const denied = mockGuard();
  if (denied) return denied;
  const { path } = await ctx.params;
  if (zernioTokenIsBad(req.headers.get("authorization"))) return unauthorized();
  const route = path.join("/");
  const state = zernioMockState();
  if (state.down.includes(route)) return unavailable();

  if (route === "webhooks/settings") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const i = state.webhooks.findIndex((w) => w._id === body.webhookId);
    if (i < 0) {
      return Response.json({ error: { message: "Webhook not found" } }, { status: 404 });
    }
    const webhook = webhookFrom(body, state.webhooks[i]!);
    state.webhooks[i] = webhook;
    return Response.json({ success: true, webhook });
  }
  return Response.json({});
}
