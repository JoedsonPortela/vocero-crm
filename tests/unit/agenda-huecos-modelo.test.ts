import { describe, expect, it } from "vitest";
import {
  CABECERA_HUECOS,
  findOffered,
  mapaDeHuecosParaModelo,
} from "@/server/agenda/offers";

/**
 * 015 / issue #50 — Os horários livres que o modelo pode usar de fato.
 *
 * `book_slot` exige o `startUtc` e `findOffered` compara por epoch exato,
 * sem tolerância. Ao modelo só chegavam o prompt e o histórico de
 * TEXTO, onde estão os rótulos que o cliente leu —«lun 7 sep, 11:00»—
 * sem ano, sem fuso e sem a data de hoje. Acertar o instante era questão de
 * sorte, a recusa caía sempre em `slot_not_offered`, e a conversa ficava
 * em loop repetindo a mesma lista.
 */

const OFERTAS = [
  { startUtc: "2026-09-07T15:00:00.000Z", label: "lun 7 sep, 09:00" },
  { startUtc: "2026-09-07T17:00:00.000Z", label: "lun 7 sep, 11:00" },
];

describe("mapaDeHuecosParaModelo", () => {
  it("empareja cada etiqueta con su instante exacto", () => {
    const mapa = mapaDeHuecosParaModelo(OFERTAS)!;
    expect(mapa).toContain('- "lun 7 sep, 09:00" → 2026-09-07T15:00:00.000Z');
    expect(mapa).toContain('- "lun 7 sep, 11:00" → 2026-09-07T17:00:00.000Z');
  });

  it("lleva la cabecera que dice qué hacer con esos valores", () => {
    expect(mapaDeHuecosParaModelo(OFERTAS)).toContain(CABECERA_HUECOS);
  });

  /**
   * Sem isso, o modelo poderia inventar uma reserva antes de ter ofertado
   * nada — e o motor a rejeitaria, voltando ao loop por outro caminho.
   */
  it("sin oferta vigente no hay bloque: hay que ofrecer antes de reservar", () => {
    expect(mapaDeHuecosParaModelo([])).toBeNull();
  });

  /**
   * A invariante que fecha o círculo: o que o mapa mostra tem que ser
   * exatamente o que `findOffered` aceita. Se o formato do ISO mudasse de
   * um lado e não do outro, voltaríamos ao mesmo loop sem que nada avisasse.
   */
  it("todo instante del mapa es aceptado por findOffered", () => {
    const mapa = mapaDeHuecosParaModelo(OFERTAS)!;
    const instantes = mapa.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
    expect(instantes).toHaveLength(OFERTAS.length);
    for (const iso of instantes) {
      expect(findOffered(OFERTAS, iso)).not.toBeNull();
    }
  });

  it("una etiqueta con comillas no rompe el formato de la línea", () => {
    const mapa = mapaDeHuecosParaModelo([
      { startUtc: "2026-09-07T15:00:00.000Z", label: 'mar 8 "temprano"' },
    ])!;
    expect(mapa.split("\n")).toHaveLength(2);
    expect(mapa).toContain("→ 2026-09-07T15:00:00.000Z");
  });
});
