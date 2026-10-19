/**
 * Para quem vai uma mensagem da Cloud API: telefone ou BSUID.
 *
 * A Meta os pede em campos DIFERENTES, e essa é toda a história deste módulo:
 *
 *   - telefone → `{ to: "<E.164>" }`
 *   - BSUID    → `{ recipient_type: "individual", recipient: "<BSUID>" }`
 *
 * Estava-se enviando o BSUID em `to`, onde a Meta espera um número. A resposta era
 * um 131026 — «o destinatário não pode receber mensagens do WhatsApp (número
 * inexistente, sem conta ou que não aceita mensagens de empresas)» — então o
 * CRM culpava o cliente do membro por um campo mal colocado.
 *
 * Quando chega um contato sem telefone, segundo a documentação da Meta: o
 * usuário ativou o nome de usuário, não houve interação com esse número
 * da empresa em 30 dias, e ele não está na agenda. As três ao mesmo tempo. Por isso
 * falhava com alguns contatos e com outros não, o que justamente fazia
 * parecer um mistério.
 *
 * Vive à parte porque há QUATRO lugares que montam envios (texto, anexos,
 * localização/contatos e modelos) e com uma cópia em cada um bastaria esquecer
 * a quinta.
 */
export type Destinatario =
  | { to: string }
  | { recipient_type: "individual"; recipient: string };

/**
 * O `phone` prevalece quando existe: a documentação diz que se vierem os dois, o
 * telefone tem precedência, então enviar ambos só acrescentaria ruído.
 */
export function destinatarioMeta(
  phone: string | null,
  bsuid: string | null
): Destinatario | null {
  if (phone) return { to: phone };
  if (bsuid) return { recipient_type: "individual", recipient: bsuid };
  return null;
}

/** Este destinatário é um BSUID? Para decidir o que pode ser enviado a ele. */
export function esBsuid(d: Destinatario): boolean {
  return "recipient" in d;
}
