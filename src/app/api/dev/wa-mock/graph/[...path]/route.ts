import { mockGuard } from "@/lib/dev-guard";
import { getEnv } from "@/lib/env";
import {
  getWaMockState,
  nextN,
  nextOutboundWamid,
  type MockTemplate,
} from "@/server/dev/wa-mock-state";

/**
 * Imitação da Graph API (contrato mocks.md). O cliente real aponta para cá
 * quando META_GRAPH_BASE_URL = <app>/api/dev/wa-mock/graph — o código de
 * produção não sabe que fala com um mock.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

/** 016 — Catálogo fechado da Meta para `business_messaging` (igual ao real). */
const CAPI_EVENT_NAMES = new Set([
  "Purchase",
  "LeadSubmitted",
  "QualifiedLead",
  "InitiateCheckout",
  "AddToCart",
  "ViewContent",
  "OrderCreated",
  "OrderShipped",
  "OrderDelivered",
  "OrderCanceled",
  "OrderReturned",
  "CartAbandoned",
  "RatingProvided",
  "ReviewProvided",
]);

/** O app da Meta "dono" do token no mock (o que fica inscrito). */
const MOCK_APP = {
  id: "mock-app",
  name: "App de prueba Vocero",
  link: "https://www.facebook.com/games/?app_id=mock-app",
};

function bearerToken(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function invalidTokenResponse(): Response {
  return Response.json(
    {
      error: {
        message: "Invalid OAuth access token - Cannot parse access token",
        type: "OAuthException",
        code: 190,
        fbtrace_id: "mock",
      },
    },
    { status: 401 }
  );
}

/**
 * Tokens com os quais o mock imita duas recusas reais da Meta ao registrar
 * o webhook: sem `whatsapp_business_management` (código 200) e um app sem
 * callback URL própria (o GET de `webhook_configuration` não traz
 * `application`).
 */
const SIN_GESTION = "-sin-gestion";
const SIN_WEBHOOK_DE_APP = "-sin-app";

function permissionErrorResponse(): Response {
  return Response.json(
    {
      error: {
        message: "(#200) Permissions error",
        type: "OAuthException",
        code: 200,
        fbtrace_id: "mock",
      },
    },
    { status: 403 }
  );
}

function callbackVerificationFailed(failure: string): Response {
  return Response.json(
    {
      error: {
        message: `(#2200) Callback verification failed with the following errors: ${failure}`,
        type: "OAuthException",
        code: 2200,
        fbtrace_id: "mock",
      },
    },
    { status: 400 }
  );
}

/**
 * A Meta verifica o callback ANTES de aceitar um override: faz o mesmo
 * GET de inscrição que ao configurar no painel, e se não devolver o
 * challenge, recusa com 2200. O mock faz isso de verdade contra a URL, assim
 * um verify token que não bate com a rota não passa em verde.
 *
 * Se a URL for a desta mesma instância (`APP_BASE_URL`), fala-se com ela por
 * loopback, como faz o `deliverToWebhook`: o domínio público pode não
 * resolver de dentro do processo e o que se testa é a rota e o token.
 */
async function callbackVerificationError(
  uri: string,
  verifyToken: string
): Promise<string | null> {
  const challenge = String(nextN() * 7919);
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "Invalid URL";
  }
  const own = getEnv().APP_BASE_URL.replace(/\/$/, "");
  if (url.origin === own) {
    url = new URL(`http://127.0.0.1:${process.env.PORT ?? "3000"}${url.pathname}${url.search}`);
  }
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.challenge", challenge);
  url.searchParams.set("hub.verify_token", verifyToken);
  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    if (res.status === 200 && text === challenge) return null;
    return `HTTP Status Code = ${res.status}; the challenge did not match`;
  } catch {
    return "Couldn't connect to server";
  }
}

/** Um telefone da Meta é só dígitos; um BSUID tem prefixo e ponto. */
function esSoloDigitos(valor: string): boolean {
  return /^[0-9]+$/.test(valor);
}

/** Remove o segmento de versão (v25.0/...) se vier na rota. */
function normalizePath(path: string[]): string[] {
  return path[0] && /^v\d+/.test(path[0]) ? path.slice(1) : path;
}

export async function GET(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const path = normalizePath((await ctx.params).path);
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();

  // GET {wabaId}/message_templates → lista para o sync
  if (path.length === 2 && path[1] === "message_templates") {
    const state = getWaMockState();
    return Response.json({
      data: state.templates.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        components: t.components ?? [{ type: "BODY", text: t.body }],
      })),
    });
  }

  // GET {wabaId}/subscribed_apps → o app inscrito e, se houver, o seu override
  // de callback. Mesma forma da Meta; sem inscrição, `data` vazio.
  if (path.length === 2 && path[1] === "subscribed_apps") {
    const sub = getWaMockState().wabaSubscriptions[path[0]!];
    return Response.json({
      data: sub
        ? [
            {
              whatsapp_business_api_data: MOCK_APP,
              ...(sub.overrideCallbackUri
                ? { override_callback_uri: sub.overrideCallbackUri }
                : {}),
            },
          ]
        : [],
    });
  }

  // GET {mediaId} (ids "media...") → metadados de anexo (media proxy do bot)
  if (path.length === 1 && path[0]!.startsWith("media")) {
    const origin = new URL(req.url).origin;
    return Response.json({
      id: path[0],
      mime_type: path[0]!.includes("pdf") ? "application/pdf" : "image/jpeg",
      file_size: 13,
      url: `${origin}/api/dev/wa-mock/media-file/${path[0]}`,
    });
  }

  // 017 — GET {psid}?fields=first_name,last_name → perfil de quem escreve
  // pelo Messenger (a ingestão consulta na primeira vez que vê um PSID).
  const fields = new URL(req.url).searchParams.get("fields") ?? "";

  // GET {phoneNumberId}?fields=webhook_configuration → o override vigente
  // do número e a callback URL do app (ausente com um token "-sem-app").
  if (path.length === 1 && fields.includes("webhook_configuration")) {
    const override = getWaMockState().phoneWebhooks[path[0]!];
    return Response.json({
      webhook_configuration: {
        ...(override ? { phone_number: override } : {}),
        ...(token.endsWith(SIN_WEBHOOK_DE_APP)
          ? {}
          : { application: "https://app-de-meta.mock/webhook" }),
      },
      id: path[0],
    });
  }

  if (path.length === 1 && fields.includes("first_name")) {
    return Response.json({
      id: path[0],
      first_name: "Cliente",
      last_name: "de Messenger",
    });
  }

  // 017 — GET {pageId}?fields=id,name → validação da página do Facebook
  if (path.length === 1 && /(^|,)name(,|$)/.test(fields)) {
    return Response.json({ id: path[0], name: "Página de prueba Vocero" });
  }

  // GET {phoneNumberId}?fields=... → validação do wizard
  if (path.length === 1) {
    return Response.json({
      display_phone_number: "+52 55 0000 0000",
      verified_name: "Número de prueba Vocero",
      id: path[0],
    });
  }

  return Response.json({});
}

export async function POST(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const path = normalizePath((await ctx.params).path);
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();

  // POST {phoneNumberId}/media (multipart, 008) → id da mídia enviada.
  // Vem ANTES do parse do JSON: o body é form-data.
  if (path.length === 2 && path[1] === "media") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      return Response.json(
        { error: { message: "missing file", type: "GraphMethodException", code: 100 } },
        { status: 400 }
      );
    }
    // O id começa com "media" para que o GET de metadados o resolva.
    return Response.json({ id: `media-up-${nextN()}` });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // 016 — POST {datasetId}/events: Conversions API. Imita as três coisas que
  // de fato importam do endpoint real: o catálogo fechado de nomes, a
  // exigência do ctwa_clid e — sobretudo — que a Meta pode responder 200
  // DESCARTANDO o evento. Os datasets terminados em "-fail" reproduzem isso
  // por último, que é o modo de falha que ninguém vê chegar.
  if (path.length === 2 && path[1] === "events") {
    const state = getWaMockState();
    const events = Array.isArray(body.data)
      ? (body.data as Record<string, unknown>[])
      : [];
    const event = events[0];
    const eventName = String(event?.event_name ?? "");
    const userData = (event?.user_data ?? {}) as Record<string, unknown>;
    const ctwaClid = userData.ctwa_clid ? String(userData.ctwa_clid) : null;

    if (!CAPI_EVENT_NAMES.has(eventName)) {
      return Response.json(
        {
          error: {
            message: `(#100) Invalid parameter: event_name ${eventName || "(vacío)"}`,
            type: "GraphMethodException",
            code: 100,
            fbtrace_id: "mock-capi-badname",
          },
        },
        { status: 400 }
      );
    }
    if (!ctwaClid) {
      return Response.json(
        {
          error: {
            message: "Messaging Event Invalid Ctwa Clid",
            type: "GraphMethodException",
            code: 100,
            error_subcode: 2804087,
            fbtrace_id: "mock-capi-noclid",
          },
        },
        { status: 400 }
      );
    }

    const datasetId = path[0]!;
    state.capiEvents.push({
      n: nextN(),
      datasetId,
      eventName,
      ctwaClid,
      customData:
        (event?.custom_data as Record<string, unknown> | undefined) ?? null,
      body,
      at: new Date().toISOString(),
    });

    // O 200 mentiroso: recebido por HTTP, descartado pela Meta.
    const received = datasetId.endsWith("-fail") ? 0 : 1;
    return Response.json({
      events_received: received,
      messages: [],
      fbtrace_id: `mock-capi-${state.capiEvents.length}`,
    });
  }

  // POST {phoneNumberId}/messages com status:"read" → digitando/lido:
  // NÃO é uma mensagem de saída — não contamina o outbox.
  if (path.length === 2 && path[1] === "messages" && body.status === "read") {
    return Response.json({ success: true });
  }

  // POST {phoneNumberId}/messages → registra no outbox
  if (path.length === 2 && path[1] === "messages") {
    const state = getWaMockState();

    /**
     * A Meta espera um TELEFONE em `to`. Um BSUID ali retorna 131026 — «o
     * destinatário não pode receber mensagens» — e o mock replica isso.
     *
     * Sem isso, mandar o BSUID no campo errado passava em verde aqui e
     * falhava em produção, que é exatamente o que aconteceu. O BSUID vai
     * em `recipient`, com `recipient_type: "individual"`.
     */
    const destino = body.to as string | undefined;
    if (destino && !esSoloDigitos(destino)) {
      return Response.json(
        {
          error: {
            message:
              "(#131026) Message undeliverable: recipient is not a valid WhatsApp user",
            code: 131026,
            type: "OAuthException",
          },
        },
        { status: 400 }
      );
    }
    // A Meta responde 132000 se os parâmetros não baterem com as {{n}} do
    // template aprovado. O mock replica isso para que um descompasso não passe.
    if (body.type === "template") {
      const tplSend = body.template as
        | {
            name?: string;
            components?: { type?: string; parameters?: unknown[] }[];
          }
        | undefined;
      const known = state.templates.find((t) => t.name === tplSend?.name);
      if (known) {
        const expected = [...known.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].reduce(
          (max, m) => Math.max(max, Number(m[1])),
          0
        );
        const got =
          tplSend?.components?.find(
            (c) => (c.type ?? "").toLowerCase() === "body"
          )?.parameters?.length ?? 0;
        if (expected !== got) {
          return Response.json(
            {
              error: {
                message: `(#132000) Number of parameters does not match the expected number of params: expected ${expected}, got ${got}`,
                type: "OAuthException",
                code: 132000,
                fbtrace_id: "mock",
              },
            },
            { status: 400 }
          );
        }
      }
    }
    const n = nextN();
    const waMessageId = nextOutboundWamid();
    state.outbox.push({
      n,
      waMessageId,
      phoneNumberId: path[0]!,
      to: String(body.to ?? ""),
      // Fica guardado à parte para que um self-test possa conferir EM QUAL CAMPO
      // viajou o destinatário, que é do que dependia a falha.
      ...(body.recipient ? { recipient: String(body.recipient) } : {}),
      type: String(body.type ?? "text"),
      body,
      at: new Date().toISOString(),
    });
    return Response.json({
      messaging_product: "whatsapp",
      contacts: [{ input: body.to, wa_id: body.to }],
      messages: [{ id: waMessageId }],
    });
  }

  // POST {wabaId}/message_templates → cadastro de template (fica PENDING)
  if (path.length === 2 && path[1] === "message_templates") {
    const state = getWaMockState();
    const components = (body.components ?? []) as {
      type?: string;
      text?: string;
      example?: { body_text?: string[][] };
    }[];
    const bodyComponent = components.find(
      (c) => (c.type ?? "").toUpperCase() === "BODY"
    );
    // A Meta valida que haja um exemplo para cada {{n}} do corpo: sem isso o
    // mock aceitaria templates que a produção recusa (erro 100).
    const highestVar = [
      ...(bodyComponent?.text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g),
    ].reduce((max, m) => Math.max(max, Number(m[1])), 0);
    const examples = bodyComponent?.example?.body_text?.[0] ?? [];
    if (highestVar !== examples.length) {
      return Response.json(
        {
          error: {
            message: `Invalid parameter: expected ${highestVar} example value(s) for the body, got ${examples.length}`,
            type: "GraphMethodException",
            code: 100,
            fbtrace_id: "mock",
          },
        },
        { status: 400 }
      );
    }
    const tpl: MockTemplate = {
      id: `tplmock_${nextN()}`,
      name: String(body.name ?? ""),
      language: String(body.language ?? "es_MX"),
      category: String(body.category ?? "UTILITY"),
      status: "PENDING",
      body: bodyComponent?.text ?? "",
      components,
    };
    state.templates.push(tpl);
    return Response.json({ id: tpl.id, status: "PENDING", category: tpl.category });
  }

  // POST {wabaId}/subscribed_apps → inscreve o app. Como na Meta, o override
  // de callback é definido enviando-o no corpo, e um POST SEM ele o APAGA
  // ("Delete WABA alternate callback"): um CRM que reinscreve às cegas
  // desconecta aqui o cérebro externo igual à produção.
  if (path.length === 2 && path[1] === "subscribed_apps") {
    if (token.endsWith(SIN_GESTION)) return permissionErrorResponse();
    const uri =
      typeof body.override_callback_uri === "string"
        ? body.override_callback_uri.trim()
        : "";
    getWaMockState().wabaSubscriptions[path[0]!] = {
      overrideCallbackUri: uri || null,
    };
    return Response.json({ success: true });
  }

  // POST {phoneNumberId} com webhook_configuration → override do NÚMERO, o
  // que o CRM registra ao salvar a conexão. Como na Meta: exige a
  // permissão de gestão, verifica o callback (handshake) antes de aceitá-lo e
  // uma string vazia o remove.
  if (path.length === 1 && body.webhook_configuration) {
    if (token.endsWith(SIN_GESTION)) return permissionErrorResponse();
    const config = body.webhook_configuration as {
      override_callback_uri?: string;
      verify_token?: string;
    };
    const state = getWaMockState();
    const uri = config.override_callback_uri ?? "";
    if (!uri) {
      delete state.phoneWebhooks[path[0]!];
      return Response.json({ success: true });
    }
    const failure = await callbackVerificationError(uri, config.verify_token ?? "");
    if (failure) return callbackVerificationFailed(failure);
    state.phoneWebhooks[path[0]!] = uri;
    return Response.json({ success: true });
  }

  return Response.json({});
}

export async function DELETE(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();
  await ctx.params;
  return Response.json({ success: true });
}
