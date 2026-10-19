import { describe, expect, it } from "vitest";
import { destinatarioMeta, esBsuid } from "@/lib/meta/destinatario";

/**
 * Para quem vai uma mensagem da Cloud API.
 *
 * A Meta pede o telefone e o BSUID em campos DIFERENTES:
 *
 *   telefone → `{ to }`
 *   BSUID    → `{ recipient_type: "individual", recipient }`
 *
 * Mandava-se o BSUID em `to`, onde a Meta espera um número, e respondia
 * 131026 — «o destinatário não pode receber mensagens do WhatsApp (número
 * inexistente, sem conta ou que não aceita mensagens de empresas)». Ou seja: o
 * CRM jogava a culpa no cliente do membro por um campo mal posto.
 *
 * Só se via com alguns contatos porque a Meta omite o telefone quando
 * coincidem TRÊS condições: o usuário ativou seu nome de usuário, não houve
 * interação com esse número da empresa em 30 dias, e ele não está na
 * agenda. Por isso parecia aleatório.
 */

describe("destinatarioMeta", () => {
  it("un teléfono va en `to`", () => {
    expect(destinatarioMeta("5214627015001", null)).toEqual({
      to: "5214627015001",
    });
  });

  it("un BSUID va en `recipient`, con su `recipient_type`", () => {
    expect(destinatarioMeta(null, "CO.1502852711544066")).toEqual({
      recipient_type: "individual",
      recipient: "CO.1502852711544066",
    });
  });

  /**
   * A documentação diz que, se forem os dois, o telefone tem precedência.
   * Enviar ambos só acrescentaria um campo que a Meta ignora.
   */
  it("con los dos, gana el teléfono y el BSUID no viaja", () => {
    const d = destinatarioMeta("5214627015001", "CO.150285");
    expect(d).toEqual({ to: "5214627015001" });
    expect(JSON.stringify(d)).not.toContain("CO.150285");
  });

  it("sin ninguno de los dos no hay destinatario", () => {
    expect(destinatarioMeta(null, null)).toBeNull();
  });

  /**
   * A invariante que impede a falha original: o BSUID NUNCA pode acabar
   * em `to`. Se alguém inverter a condição, isto avisa.
   */
  it("el BSUID jamás aparece en `to`", () => {
    const d = destinatarioMeta(null, "CO.1502852711544066")!;
    expect("to" in d).toBe(false);
    expect(esBsuid(d)).toBe(true);
    expect(esBsuid({ to: "521462" })).toBe(false);
  });
});
