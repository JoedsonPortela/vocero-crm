import { describe, expect, it } from "vitest";
import { comparable, delta, MIN_SAMPLE, rate } from "@/lib/analytics";
import { armarEmbudo, clasificarCierres, motivosDePerdida, type Desenlace } from "@/server/analytics/sales";
import { MAX_ANUNCIOS, unirAnuncios, unirFuentes } from "@/server/analytics/ads";
import { escalaLimpia, etiqueta } from "@/components/results/time-bars";

/**
 * 019 — A aritmética da tela Resultados (portado do Vocero Cloud, sem
 * os casos do gasto publicitário nem da probabilidade de fechamento).
 *
 * Toda taxa da tela passa por `rate`. Estes testes são o que permite
 * que a UI nunca divida.
 */

describe("rate", () => {
  it("sin denominador devuelve null, no cero", () => {
    // Zero por cento significa "tentei e falhou". Null significa "não
    // aconteceu nada ainda". A tela os diz com palavras diferentes.
    const r = rate(0, 0);
    expect(r.value).toBeNull();
    expect(r.sample).toBe(0);
    expect(r.reliable).toBe(false);
  });

  it("el denominador viaja SIEMPRE con el porcentaje", () => {
    expect(rate(1, 2).sample).toBe(2);
  });

  it("marca la muestra chica en vez de esconderla", () => {
    // 1 de 1 é 100 %, e apresentá-lo como firme seria mentir com a verdade.
    const flaca = rate(1, 1);
    expect(flaca.value).toBe(100);
    expect(flaca.reliable).toBe(false);
    expect(rate(5, MIN_SAMPLE).reliable).toBe(true);
  });

  it("redondea a entero", () => {
    expect(rate(1, 3).value).toBe(33);
    expect(rate(2, 3).value).toBe(67);
  });

  it("un denominador negativo no revienta", () => {
    expect(rate(1, -5).value).toBeNull();
  });
});

describe("delta", () => {
  it("sin base previa es null, no un aumento infinito", () => {
    // De 0 a 8 não é "+800 %": é que antes não havia com o que comparar.
    expect(delta(comparable(8, 0))).toBeNull();
  });

  it("calcula la variación en ambos sentidos", () => {
    expect(delta(comparable(12, 10))).toBe(20);
    expect(delta(comparable(8, 10))).toBe(-20);
  });
});

const desenlace = (d: Partial<Desenlace> & Pick<Desenlace, "leadId" | "kind">): Desenlace => ({
  lossReason: null,
  amountCents: null,
  currency: null,
  ...d,
});

describe("clasificarCierres", () => {
  it("cuenta el LEAD, y el dinero solo en la moneda del negocio", () => {
    const c = clasificarCierres(
      [
        desenlace({ leadId: "a", kind: "won", amountCents: 100_00, currency: "MXN" }),
        // Sem moeda = a do negócio ao capturá-lo.
        desenlace({ leadId: "b", kind: "won", amountCents: 50_00 }),
        // Outra moeda: conta-se como negócio, não se soma.
        desenlace({ leadId: "c", kind: "won", amountCents: 999_00, currency: "USD" }),
        // Sem valor: negócio ganho, não soma nem entra no ticket médio.
        desenlace({ leadId: "d", kind: "won" }),
        desenlace({ leadId: "e", kind: "lost", lossReason: "precio" }),
        // Voltou ao funil dentro do intervalo: não fechou nada.
        desenlace({ leadId: "f", kind: "open", amountCents: 70_00 }),
      ],
      "MXN"
    );
    expect(c.won).toEqual(["a", "b", "c", "d"]);
    expect(c.lost).toEqual(["e"]);
    expect(c.wonCents).toBe(150_00);
    expect(c.wonWithAmount).toBe(2);
  });
});

describe("motivosDePerdida", () => {
  it("sale del mismo desenlace: solo los perdidos, del más frecuente al menos", () => {
    const m = motivosDePerdida([
      desenlace({ leadId: "a", kind: "lost", lossReason: "precio" }),
      desenlace({ leadId: "b", kind: "lost", lossReason: "precio" }),
      // Semeado pela migração: perdido sem motivo capturado.
      desenlace({ leadId: "c", kind: "lost" }),
      desenlace({ leadId: "d", kind: "won" }),
    ]);
    expect(m).toEqual([
      { reason: "precio", label: "Le pareció caro", count: 2 },
      { reason: "sin_registro", label: "Sin motivo registrado", count: 1 },
    ]);
  });
});

describe("armarEmbudo", () => {
  const etapas = [
    { id: "s1", name: "Novo", kind: "open" as const, position: 0 },
    { id: "s2", name: "Interessado", kind: "open" as const, position: 1 },
    { id: "s3", name: "Cotizado", kind: "open" as const, position: 2 },
    // Perdido com uma posição alta: NÃO pode contar como "passou por todas".
    { id: "sl", name: "Perdido", kind: "lost" as const, position: 9 },
    { id: "sw", name: "Cliente", kind: "won" as const, position: 3 },
  ];

  it("cada lead cuenta una vez por etapa y el acumulado solo corre sobre abiertas", () => {
    const pasos = armarEmbudo(etapas, [
      { maxOpenPos: 0, won: 0 }, // ficou em Nuevo
      { maxOpenPos: 1, won: 0 }, // chegou a Interesado e foi perdido
      { maxOpenPos: 2, won: 1 }, // até Cotizado e foi ganho
      { maxOpenPos: 0, won: 1 }, // de Nuevo direto a Cliente
      { maxOpenPos: null, won: 0 }, // suas etapas já não existem
    ]);
    expect(pasos.map((p) => [p.name, p.reached])).toEqual([
      ["Novo", 4],
      ["Interessado", 2],
      ["Cotizado", 1],
      ["Cliente", 2],
    ]);
    expect(pasos.find((p) => p.name === "Perdido")).toBeUndefined();
    // A proporção que passa para a seguinte, com seu denominador.
    expect(pasos[0]!.advanceRate).toEqual({ value: 50, sample: 4, reliable: false });
    expect(pasos.at(-1)!.advanceRate).toBeNull();
  });

  it("sin etapa ganada configurada, el último paso sigue llamándose Ganado", () => {
    const pasos = armarEmbudo([etapas[0]!], [{ maxOpenPos: 0, won: 1 }]);
    expect(pasos.at(-1)).toMatchObject({ name: "Ganado", kind: "won", reached: 1 });
  });
});

describe("unirFuentes", () => {
  it("las seis fuentes en su orden fijo, solo las que tienen algo, y sin identificar al final", () => {
    const filas = unirFuentes(
      [
        { key: null, n: 3 },
        { key: "anuncio", n: 5 },
      ],
      [
        { key: "anuncio", leads: 4, won: 1 },
        { key: "referido", leads: 1, won: 1 },
      ]
    );
    expect(filas.map((f) => [f.value, f.conversations, f.leads, f.won])).toEqual([
      ["anuncio", 5, 4, 1],
      ["referido", 0, 1, 1],
      ["desconocida", 3, 0, 0],
    ]);
    expect(filas[0]!.label).toBe("Anuncio");
    expect(filas.at(-1)!.label).toBe("Sin identificar");
    // A taxa da linha é vendas entre prospectos, calculada no servidor.
    expect(filas[0]!.winRate).toEqual({ value: 25, sample: 4, reliable: false });
    expect(filas.at(-1)!.winRate.value).toBeNull();
  });
});

describe("unirAnuncios", () => {
  const meta = (key: string, extra: Partial<Parameters<typeof unirAnuncios>[0][number]> = {}) => ({
    key,
    sourceId: key.startsWith("ad_") ? null : key,
    sourceType: "ad",
    headline: `Titular ${key}`,
    imageAssetId: null,
    lastAt: 1_000,
    ...extra,
  });

  it("junta conversaciones y prospectos del mismo anuncio en una fila", () => {
    const [fila] = unirAnuncios(
      [{ ...meta("1202"), conversations: 3 }],
      [{ ...meta("1202", { imageAssetId: "ma_1" }), leads: 2, won: 1 }]
    );
    expect(fila).toMatchObject({
      key: "1202",
      conversations: 3,
      leads: 2,
      won: 1,
      winRate: { value: 50, sample: 2 },
      // A imagem chega em qualquer das duas visões: ela se conserva.
      imageAssetId: "ma_1",
    });
  });

  it("un anuncio con prospectos pero sin conversaciones del periodo también sale", () => {
    const filas = unirAnuncios([], [{ ...meta("1203"), leads: 1, won: 0 }]);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ conversations: 0, leads: 1, won: 0 });
  });

  it("más conversaciones primero; a igualdad, más prospectos y luego el más reciente", () => {
    const filas = unirAnuncios(
      [
        { ...meta("viejo", { lastAt: 100 }), conversations: 2 },
        { ...meta("nuevo", { lastAt: 900 }), conversations: 2 },
        { ...meta("grande"), conversations: 7 },
        { ...meta("con-prospectos", { lastAt: 50 }), conversations: 2 },
      ],
      [{ ...meta("con-prospectos", { lastAt: 50 }), leads: 2, won: 0 }]
    );
    expect(filas.map((f) => f.key)).toEqual(["grande", "con-prospectos", "nuevo", "viejo"]);
    // O instante de ordenação não viaja ao cliente.
    expect(filas[0]).not.toHaveProperty("lastAt");
  });

  it(`corta en ${MAX_ANUNCIOS} filas`, () => {
    const muchas = Array.from({ length: MAX_ANUNCIOS + 5 }, (_, i) => ({
      ...meta(`a${i}`),
      conversations: i + 1,
    }));
    const filas = unirAnuncios(muchas, []);
    expect(filas).toHaveLength(MAX_ANUNCIOS);
    expect(filas[0]!.conversations).toBe(MAX_ANUNCIOS + 5);
  });
});

describe("escala y etiquetas de la serie", () => {
  it("el tope es un número limpio que cubre el máximo", () => {
    expect(escalaLimpia(0)).toBe(1);
    expect(escalaLimpia(1)).toBe(1);
    expect(escalaLimpia(3)).toBe(5);
    expect(escalaLimpia(37)).toBe(50);
    expect(escalaLimpia(120)).toBe(200);
  });

  it("fechas cortas en español", () => {
    expect(etiqueta("2026-08-13")).toBe("13 ago");
    expect(etiqueta("2026-01")).toBe("ene 26");
  });
});
