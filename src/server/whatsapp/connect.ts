import { graphRequest, MetaApiError } from "@/lib/meta/client";

export type ConnectionCheck =
  | {
      ok: true;
      displayPhoneNumber: string;
      verifiedName: string | null;
    }
  | { ok: false; code: "invalid_token" | "meta_unavailable" | "meta_error"; message: string };

/**
 * Valida token↔número contra a Graph API SEM persistir nada (FR-040):
 * um GET do número com o token deve devolver seu display_phone_number.
 */
export async function testConnection(
  phoneNumberId: string,
  token: string
): Promise<ConnectionCheck> {
  try {
    const res = await graphRequest<{
      display_phone_number?: string;
      verified_name?: string;
      id: string;
    }>(`${phoneNumberId}?fields=display_phone_number,verified_name`, {
      token,
    });
    if (!res.display_phone_number) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta no devolvió el número: verifica que el Phone Number ID sea correcto",
      };
    }
    return {
      ok: true,
      displayPhoneNumber: res.display_phone_number,
      verifiedName: res.verified_name ?? null,
    };
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        return {
          ok: false,
          code: "invalid_token",
          message:
            "El token no es válido o expiró. Verifica que corresponde a este número (modo directo: token de usuario del sistema; modo agencia: token entregado por tu backend).",
        };
      }
      if (err.status === 0 || err.status >= 500) {
        return {
          ok: false,
          code: "meta_unavailable",
          message: "Meta no está disponible en este momento; intenta de nuevo",
        };
      }
      return { ok: false, code: "meta_error", message: err.message };
    }
    throw err;
  }
}

/** Resposta de `GET {WABA}/subscribed_apps`: uma entrada por app inscrita. */
type SubscribedApps = {
  data?: {
    whatsapp_business_api_data?: { id?: string; name?: string; link?: string };
    override_callback_uri?: string;
  }[];
};

/** Resposta de `GET {phone}?fields=webhook_configuration`. */
type WebhookConfiguration = {
  webhook_configuration?: {
    /** Override vigente em nível do número. */
    phone_number?: string;
    /** Override vigente em nível da WABA. */
    waba?: string;
    /** A callback URL do painel do app. */
    application?: string;
  };
};

export type WebhookRegistration =
  | {
      ok: true;
      /**
       * A Meta não informa callback URL em nível de app. Os campos (`messages`) são
       * inscritos por app, no seu painel —a API de inscrições de app não
       * admite WhatsApp—, e o override só redireciona o que o app recebe.
       * Um app sem webhook próprio é o suspeito se não chegar nada.
       */
      appWithoutWebhook: boolean;
    }
  | {
      ok: true;
      /**
       * A WABA já roteia seus webhooks para outro lugar (um cérebro externo que
       * recebe da Meta e conversa por `/api/bot/*`, ou o backend de uma
       * agência). Respeita-se: não se registra o do número, que ganharia.
       */
      skipped: "waba_override";
      /** Só o host: a rota de um override costuma levar um segredo. */
      host: string;
    }
  | {
      ok: false;
      code: "invalid_token" | "missing_permission" | "meta_unavailable" | "meta_error";
      message: string;
    };

/**
 * Registra na Meta o webhook desta instância para o número conectado,
 * para que ninguém precise colá-lo à mão no painel do app.
 *
 * Três passos, pela API do Graph e com o token do próprio negócio:
 *
 *   1. `GET /{waba}/subscribed_apps`: se alguma app já roteia a WABA para um
 *      override ALHEIO, aqui termina (`skipped`): o override do número tem
 *      prioridade sobre o da WABA e deixaria surdo quem o colocou. E se um
 *      salvamento anterior tiver deixado o nosso no número, ele é removido.
 *      Sem override, `POST /{waba}/subscribed_apps` sem corpo: a Meta o
 *      exige antes de qualquer override. Com um nosso (o de uma agência
 *      apontando para esta mesma instância), não se re-inscreve: esse POST o apagaria.
 *   2. `POST /{phone}` com `webhook_configuration`: override em nível NÚMERO.
 *      A Meta verifica a URL nesse momento (handshake com o verify token).
 *   3. `GET /{phone}?fields=webhook_configuration`: confirma que ficou.
 *
 * Por que no número e não na WABA: o do número sobrevive a qualquer
 * `subscribed_apps` sem corpo e é o que a Meta olha primeiro. Jamais lança por
 * uma resposta da Meta: salvar a conexão não pode falhar por isto.
 */
export async function registerWebhookForNumber(opts: {
  wabaId: string;
  phoneNumberId: string;
  token: string;
  webhookUrl: string;
  verifyToken: string;
}): Promise<WebhookRegistration> {
  const { wabaId, phoneNumberId, token, webhookUrl, verifyToken } = opts;
  const ownPath = pathOf(webhookUrl);

  const override = await wabaOverride(wabaId, token);
  if (override && !sameWebhookPath(override, ownPath)) {
    const host = hostOf(override);
    console.log(
      `[connect] la WABA ${wabaId} enruta sus webhooks a un override (${host}): se respeta y no se registra el del número`
    );
    await unregisterWebhookForNumber({ phoneNumberId, token, webhookPath: ownPath });
    return { ok: true, skipped: "waba_override", host };
  }
  if (!override) {
    try {
      await graphRequest(`${wabaId}/subscribed_apps`, { method: "POST", token });
    } catch (err) {
      return registrationError(err, "No se pudo suscribir la app a la cuenta de WhatsApp");
    }
  }

  try {
    await graphRequest(phoneNumberId, {
      method: "POST",
      token,
      body: {
        webhook_configuration: {
          override_callback_uri: webhookUrl,
          verify_token: verifyToken,
        },
      },
    });
  } catch (err) {
    return registrationError(err, "Meta no aceptó la dirección del webhook");
  }

  try {
    const res = await graphRequest<WebhookConfiguration>(
      `${phoneNumberId}?fields=webhook_configuration`,
      { token }
    );
    if (res.webhook_configuration?.phone_number !== webhookUrl) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta aceptó el webhook pero no lo confirma en el número. Vuelve a intentarlo en unos minutos.",
      };
    }
    return { ok: true, appWithoutWebhook: !res.webhook_configuration.application };
  } catch (err) {
    return registrationError(err, "No se pudo confirmar el webhook en Meta");
  }
}

/**
 * Remove o override do número ao desconectar, se for o desta instância.
 *
 * Sem isto, o número continuaria enviando suas mensagens para cá depois de
 * soltá-lo: o override do número ganha de qualquer outro webhook, então o
 * dono configuraria o seu no painel da Meta e não receberia nada.
 *
 * Compara-se pela ROTA (`/api/webhooks/wa/<verify token>`), não pela URL
 * inteira: o domínio pode ter mudado desde que foi salvo. E só se toca se for
 * nosso — um override alheio não é assunto do CRM. Best-effort: desconectar
 * não pode falhar porque a Meta não responde.
 */
export async function unregisterWebhookForNumber(opts: {
  phoneNumberId: string;
  token: string;
  webhookPath: string;
}): Promise<void> {
  const { phoneNumberId, token, webhookPath } = opts;
  try {
    const res = await graphRequest<WebhookConfiguration>(
      `${phoneNumberId}?fields=webhook_configuration`,
      { token }
    );
    const actual = res.webhook_configuration?.phone_number;
    if (!actual || !sameWebhookPath(actual, webhookPath)) return;
    await graphRequest(phoneNumberId, {
      method: "POST",
      token,
      body: { webhook_configuration: { override_callback_uri: "" } },
    });
  } catch (err) {
    console.warn(
      "[connect] no se pudo quitar el webhook del número al desconectar:",
      err instanceof MetaApiError ? `${err.status} ${err.code ?? ""}` : "sin respuesta"
    );
  }
}

/**
 * O override de callback vigente na WABA, se alguma app inscrita o tiver.
 *
 * Um `POST {WABA}/subscribed_apps` sem corpo não é inócuo: é justamente como a Meta
 * documenta APAGAR o callback alternativo da WABA ("Delete WABA alternate
 * callback"). Se a WABA já roteia para um override (o backend de uma agência,
 * ou um cérebro externo que recebe os webhooks direto da Meta), re-inscrever
 * a cada "Salvar" —ou ao rotacionar o token— o desconectaria em silêncio. Por isso
 * consulta-se antes de tocar em nada.
 *
 * `null` = nenhuma app tem override; `undefined` = não foi possível consultar (inscreve-se
 * como sempre, best-effort).
 */
async function wabaOverride(
  wabaId: string,
  token: string
): Promise<string | null | undefined> {
  try {
    const res = await graphRequest<SubscribedApps | null>(
      `${wabaId}/subscribed_apps`,
      { token }
    );
    return (
      (Array.isArray(res?.data) ? res.data : [])
        .map((app) => app?.override_callback_uri)
        .find(
          (uri): uri is string => typeof uri === "string" && uri.trim() !== ""
        ) ?? null
    );
  } catch (err) {
    console.warn(
      "[connect] no se pudo consultar subscribed_apps; se suscribe igual (best-effort):",
      err instanceof Error ? err.message : err
    );
    return undefined;
  }
}

function registrationError(err: unknown, context: string): WebhookRegistration {
  if (!(err instanceof MetaApiError)) throw err;
  if (err.isAuthError) {
    return {
      ok: false,
      code: "invalid_token",
      message: `${context}: el token no es válido o expiró.`,
    };
  }
  if (err.status === 0 || err.status >= 500) {
    return {
      ok: false,
      code: "meta_unavailable",
      message: `${context}: Meta no está disponible en este momento; intenta de nuevo.`,
    };
  }
  // 200 e 10 são de permissões: o token pode enviar mensagens mas não
  // administrar a conta (falta whatsapp_business_management).
  if (err.code === 200 || err.code === 10 || err.status === 403) {
    return {
      ok: false,
      code: "missing_permission",
      message: `${context}: el token no tiene el permiso whatsapp_business_management sobre esta cuenta.`,
    };
  }
  return { ok: false, code: "meta_error", message: `${context}: ${err.message}` };
}

function sameWebhookPath(url: string, path: string): boolean {
  return pathOf(url) === path;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host || "host desconocido";
  } catch {
    return "URL no válida";
  }
}
