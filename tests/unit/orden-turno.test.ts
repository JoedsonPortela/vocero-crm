import { describe, expect, it } from "vitest";
import {
  atendidoPorPersona,
  debidosVigentes,
  ordenarParaElTurno,
  quedanDebidos,
} from "@/server/ai/orden-turno";

/**
 * 025 — A ordem em que o agente incluído lê a conversa.
 *
 * O caso que importa: o cliente escreve outra vez enquanto o modelo pensa.
 * Pela hora de chegada essa mensagem fica ANTES da resposta à anterior, e
 * o modelo, que vê um fio terminado na sua própria resposta, o dá por
 * respondido. O turno seguinte tem que lê-la como a última coisa que foi dita.
 */

let reloj = 0;
const msg = (id: string, direction: "in" | "out", aiGenerated = direction === "out") => ({
  id,
  direction,
  aiGenerated,
  createdAt: new Date(Date.UTC(2026, 9, 13, 12, 0, reloj++)),
});
/** Uma saída escrita por uma pessoa a partir da bandeja. */
const aMano = (id: string) => msg(id, "out", false);
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

describe("ordenarParaElTurno", () => {
  it("sin debidos no mueve nada (Laboratorio y turno normal)", () => {
    const h = [msg("m1", "in"), msg("m2", "in"), msg("r1", "out")];
    expect(ids(ordenarParaElTurno(h, []))).toEqual(["m1", "m2", "r1"]);
  });

  it("lo que entró mientras el modelo pensaba va después de su respuesta", () => {
    const m1 = msg("m1", "in");
    const m2 = msg("m2", "in"); // entra com o turno de m1 em andamento
    const r1 = msg("r1", "out"); // a resposta a m1 sai depois
    expect(ids(ordenarParaElTurno([m1, m2, r1], [m2]))).toEqual(["m1", "r1", "m2"]);
  });

  it("el caso normal queda igual: lo debido ya es lo último", () => {
    const h = [msg("m0", "in"), msg("r0", "out"), msg("m1", "in")];
    expect(ids(ordenarParaElTurno(h, [h[2]!]))).toEqual(["m0", "r0", "m1"]);
  });

  it("lo debido y lo que llegó después de la respuesta se leen en su orden", () => {
    const m1 = msg("m1", "in");
    const m2 = msg("m2", "in");
    const r1 = msg("r1", "out");
    const m3 = msg("m3", "in"); // chegou depois da resposta: ninguém o moveu
    expect(ids(ordenarParaElTurno([m1, m2, r1, m3], [m2]))).toEqual([
      "m1",
      "r1",
      "m2",
      "m3",
    ]);
  });

  it("un debido que ya no cabe en la ventana del historial entra igual", () => {
    const viejo = msg("m_viejo", "in");
    const h = [msg("r1", "out"), msg("m9", "in")];
    expect(ids(ordenarParaElTurno(h, [viejo]))).toEqual(["r1", "m_viejo", "m9"]);
  });

  it("no duplica un debido que ya estaba en el historial", () => {
    const m1 = msg("m1", "in");
    const r1 = msg("r1", "out");
    expect(ids(ordenarParaElTurno([m1, r1], [m1]))).toEqual(["r1", "m1"]);
  });

  it("un saliente nunca se trata como debido", () => {
    const h = [msg("m1", "in"), msg("r1", "out")];
    expect(ids(ordenarParaElTurno(h, [h[1]!]))).toEqual(["m1", "r1"]);
  });
});

describe("debidosVigentes — lo que una persona ya contestó no se debe", () => {
  it("sin respuestas a mano, todo lo debido sigue debiéndose", () => {
    const m1 = msg("m1", "in");
    const m2 = msg("m2", "in");
    const r1 = msg("r1", "out"); // do agente: não dá baixa em m2
    expect(ids(debidosVigentes([m1, m2, r1], [m2]))).toEqual(["m2"]);
  });

  it("un debido anterior a la respuesta de una persona ya está atendido", () => {
    const m1 = msg("m1", "in");
    const h1 = aMano("h1");
    expect(debidosVigentes([m1, h1], [m1])).toEqual([]);
  });

  it("uno posterior a esa respuesta sí se debe", () => {
    const m1 = msg("m1", "in");
    const h1 = aMano("h1");
    const m2 = msg("m2", "in");
    const r2 = msg("r2", "out");
    expect(ids(debidosVigentes([m1, h1, m2, r2], [m1, m2]))).toEqual(["m2"]);
  });

  it("un debido fuera del historial se compara por hora con esa respuesta", () => {
    const viejo = msg("m_viejo", "in");
    const h1 = aMano("h1");
    const nuevo = msg("m_nuevo", "in");
    expect(ids(debidosVigentes([h1], [viejo, nuevo]))).toEqual(["m_nuevo"]);
  });
});

describe("atendidoPorPersona", () => {
  it("lo último es la respuesta de una persona → sí", () => {
    expect(atendidoPorPersona([msg("m1", "in"), aMano("h1")])).toBe(true);
  });

  it("el cliente volvió a escribir después → no", () => {
    expect(atendidoPorPersona([msg("m1", "in"), aMano("h1"), msg("m2", "in")])).toBe(false);
  });

  it("lo último es una respuesta del agente → no: eso no salda nada", () => {
    expect(atendidoPorPersona([msg("m1", "in"), msg("r1", "out")])).toBe(false);
  });

  it("una respuesta del agente después de la de la persona no cambia nada", () => {
    expect(atendidoPorPersona([msg("m1", "in"), aMano("h1"), msg("r1", "out")])).toBe(true);
  });

  it("nadie ha contestado a mano → no", () => {
    expect(atendidoPorPersona([msg("m1", "in")])).toBe(false);
    expect(atendidoPorPersona([])).toBe(false);
  });
});

describe("quedanDebidos — ¿hace falta otro turno?", () => {
  it("lo que entró mientras el modelo pensaba y el turno no leyó se debe", () => {
    expect(quedanDebidos(new Set(["m2"]), ["m1"])).toEqual(["m2"]);
  });

  it("lo que entró a tiempo de que el turno lo leyera ya está atendido", () => {
    // Entre o início do turno e a abertura do histórico cabem alguns milissegundos.
    // Repetir o turno seria responder-lhe duas vezes.
    expect(quedanDebidos(new Set(["m2"]), ["m1", "m2"])).toEqual([]);
  });

  it("si el turno no llegó a leer, todo lo anotado se sigue debiendo", () => {
    expect(quedanDebidos(new Set(["m1", "m2"]), undefined)).toEqual(["m1", "m2"]);
  });

  it("sin nada anotado no hay turno extra", () => {
    expect(quedanDebidos(new Set(), ["m1"])).toEqual([]);
  });
});
