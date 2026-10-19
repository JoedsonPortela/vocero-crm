import { describe, expect, it } from "vitest";
import {
  armarEvento,
  clasificarRespuesta,
  firmaValida,
  firmarCuerpo,
  CABECERA_DISPATCH,
  CABECERA_EVENTO,
  CABECERA_FIRMA,
  CABECERA_ORG,
} from "@/server/brains/contract";
import { entregar } from "@/server/brains/deliver";

/**
 * 021 — O contrato do despacho, fixado byte a byte.
 *
 * O que se protege: que o JSON que o CRM assina seja EXATAMENTE este. Um
 * cérebro verifica a assinatura sobre o corpo cru, então reordenar uma chave
 * ou mudar como se serializa uma data quebra todas as instalações de uma vez,
 * com um 401 mudo. A prova gêmea vive no repositório do cérebro
 * (nea-agent) com este mesmo corpo e esta mesma assinatura: mudar um lado sem o
 * outro quebra um teste, não uma instalação.
 */

const SECRETO = "llave-de-prueba-del-contrato-0001";

const CUERPO =
  '{"dispatchId":"dsp_prueba0000000000001","organization":{"id":"org_prueba","slug":"mi-negocio"},' +
  '"conversation":{"id":"cv_prueba","channel":"whatsapp","aiEnabled":true,"windowOpen":true,"windowExpiresAt":"2026-10-09T05:10:11.000Z"},' +
  '"contact":{"id":"ct_prueba","displayName":"Ana Pérez","identity":"5215512345678"},' +
  '"messages":[{"id":"msg_1","at":"2026-10-08T05:10:03.000Z","type":"text","text":"hola, ¿tienen el modelo azul?","mediaId":null},' +
  '{"id":"msg_2","at":"2026-10-08T05:10:11.000Z","type":"image","text":null,"mediaId":"1234567890","mimeType":"image/jpeg","caption":"este"}],' +
  '"firstMessageAt":"2026-10-08T05:10:03.000Z","lastMessageAt":"2026-10-08T05:10:11.000Z"}';

const FIRMA =
  "sha256=885074513a6fbd7e2d4443e7f45e3837246effed6c9efa596260057f4dd9008d";

function evento() {
  return armarEvento({
    dispatchId: "dsp_prueba0000000000001",
    organization: { id: "org_prueba", slug: "mi-negocio" },
    conversation: {
      id: "cv_prueba",
      channel: "whatsapp",
      aiEnabled: true,
      windowOpen: true,
      windowExpiresAt: new Date("2026-10-09T05:10:11.000Z"),
    },
    contact: { id: "ct_prueba", displayName: "Ana Pérez", identity: "5215512345678" },
    messages: [
      {
        id: "msg_1",
        createdAt: new Date("2026-10-08T05:10:03.000Z"),
        type: "text",
        text: "hola, ¿tienen el modelo azul?",
        media: null,
      },
      {
        id: "msg_2",
        createdAt: new Date("2026-10-08T05:10:11.000Z"),
        type: "image",
        text: null,
        media: { waMediaId: "1234567890", mimeType: "image/jpeg", caption: "este" },
      },
    ],
    firstMessageAt: new Date("2026-10-08T05:10:03.000Z"),
    lastMessageAt: new Date("2026-10-08T05:10:11.000Z"),
  });
}

describe("el evento de despacho — la forma es contrato", () => {
  it("se serializa exactamente así, clave por clave", () => {
    expect(JSON.stringify(evento())).toBe(CUERPO);
  });

  it("y se firma exactamente así", () => {
    expect(firmarCuerpo(CUERPO, SECRETO)).toBe(FIRMA);
    expect(firmarCuerpo(JSON.stringify(evento()), SECRETO)).toBe(FIRMA);
  });

  it("un adjunto sin media id (ubicación, contacto) no lleva mimeType ni caption", () => {
    const e = armarEvento({
      ...datosMinimos(),
      messages: [
        {
          id: "msg_3",
          createdAt: new Date("2026-10-08T05:10:03.000Z"),
          type: "location",
          text: null,
          media: { waMediaId: null, mimeType: null, caption: null },
        },
      ],
    });
    expect(Object.keys(e.messages[0]!)).toEqual(["id", "at", "type", "text", "mediaId"]);
    expect(e.messages[0]!.mediaId).toBeNull();
  });

  it("una conversación sin entrantes viaja con la ventana cerrada y sin vencimiento", () => {
    const e = armarEvento({
      ...datosMinimos(),
      conversation: {
        id: "cv_x",
        channel: "messenger",
        aiEnabled: true,
        windowOpen: false,
        windowExpiresAt: null,
      },
    });
    expect(e.conversation).toEqual({
      id: "cv_x",
      channel: "messenger",
      aiEnabled: true,
      windowOpen: false,
      windowExpiresAt: null,
    });
  });

  it("no lleva nada que no sea del contrato (ni teléfono suelto, ni credenciales)", () => {
    expect(Object.keys(evento())).toEqual([
      "dispatchId",
      "organization",
      "conversation",
      "contact",
      "messages",
      "firstMessageAt",
      "lastMessageAt",
    ]);
    expect(Object.keys(evento().contact)).toEqual(["id", "displayName", "identity"]);
  });
});

function datosMinimos() {
  return {
    dispatchId: "dsp_x",
    organization: { id: "org_x", slug: null },
    conversation: {
      id: "cv_x",
      channel: "instagram" as const,
      aiEnabled: true,
      windowOpen: true,
      windowExpiresAt: new Date("2026-10-09T05:10:11.000Z"),
    },
    contact: { id: "ct_x", displayName: "X", identity: "ig:123" },
    messages: [],
    firstMessageAt: new Date("2026-10-08T05:10:03.000Z"),
    lastMessageAt: new Date("2026-10-08T05:10:03.000Z"),
  };
}

describe("la firma", () => {
  it("valida el cuerpo crudo con la llave correcta", () => {
    expect(firmaValida(CUERPO, SECRETO, FIRMA)).toBe(true);
  });

  it("rechaza un byte cambiado, otra llave, la firma sin prefijo y la ausente", () => {
    expect(firmaValida(CUERPO.replace("Ana", "Ane"), SECRETO, FIRMA)).toBe(false);
    expect(firmaValida(CUERPO, `${SECRETO}x`, FIRMA)).toBe(false);
    expect(firmaValida(CUERPO, SECRETO, FIRMA.slice("sha256=".length))).toBe(false);
    expect(firmaValida(CUERPO, SECRETO, null)).toBe(false);
    expect(firmaValida(CUERPO, SECRETO, "")).toBe(false);
  });

  it("re-serializar el JSON con otro formato NO valida: se firma el crudo", () => {
    const reformateado = JSON.stringify(JSON.parse(CUERPO), null, 2);
    expect(firmaValida(reformateado, SECRETO, FIRMA)).toBe(false);
  });
});

describe("qué entiende el CRM de la respuesta del cerebro", () => {
  it.each([200, 201, 202, 204])("%i → entregado", (status) => {
    expect(clasificarRespuesta(status)).toEqual({ ok: true });
  });

  it.each([429, 500, 502, 503, 504])("%i → se reintenta", (status) => {
    expect(clasificarRespuesta(status)).toMatchObject({ ok: false, reintentable: true });
  });

  it.each([301, 302, 400, 401, 404, 409, 422])("%i → no se reintenta", (status) => {
    expect(clasificarRespuesta(status)).toMatchObject({ ok: false, reintentable: false });
  });
});

describe("entregar — el POST firmado", () => {
  const destino = { url: "http://nea:8000/vocero/dispatch", secret: SECRETO };

  it("manda el cuerpo que firma, con las cabeceras del contrato y sin seguir redirecciones", async () => {
    const llamadas: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      llamadas.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const r = await entregar(evento(), destino, { fetchImpl });
    expect(r).toEqual({ ok: true });
    expect(llamadas).toHaveLength(1);

    const { url, init } = llamadas[0]!;
    expect(url).toBe(destino.url);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBe(CUERPO);
    const headers = init.headers as Record<string, string>;
    expect(headers[CABECERA_FIRMA]).toBe(FIRMA);
    expect(headers[CABECERA_DISPATCH]).toBe("dsp_prueba0000000000001");
    expect(headers[CABECERA_ORG]).toBe("mi-negocio");
    expect(headers[CABECERA_EVENTO]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  it("sin slug, la cabecera de organización lleva el id", async () => {
    let cabecera = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      cabecera = (init?.headers as Record<string, string>)[CABECERA_ORG] ?? "";
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await entregar(armarEvento(datosMinimos()), destino, { fetchImpl });
    expect(cabecera).toBe("org_x");
  });

  it("un 500 es reintentable y un 422 no", async () => {
    const con = (status: number) =>
      (async () => new Response("x", { status })) as unknown as typeof fetch;
    expect(await entregar(evento(), destino, { fetchImpl: con(500) })).toMatchObject({
      ok: false,
      reintentable: true,
    });
    expect(await entregar(evento(), destino, { fetchImpl: con(422) })).toMatchObject({
      ok: false,
      reintentable: false,
    });
  });

  it("conexión rechazada → reintentable, y el motivo no trae la URL ni la llave", async () => {
    const fetchImpl = (async () => {
      throw new TypeError(`fetch failed: ECONNREFUSED ${destino.url} ${SECRETO}`);
    }) as unknown as typeof fetch;
    const r = await entregar(evento(), destino, { fetchImpl });
    expect(r).toEqual({
      ok: false,
      reintentable: true,
      detalle: "no se pudo conectar con el cerebro",
    });
  });

  it("un cerebro que no contesta a tiempo → reintentable, con el tiempo en el motivo", async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const r = await entregar(evento(), destino, { fetchImpl, timeoutMs: 30 });
    expect(r).toMatchObject({ ok: false, reintentable: true });
    expect((r as { detalle: string }).detalle).toContain("no contestó");
  });
});
