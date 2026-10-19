/**
 * As 6 personas ROTEIRIZADAS do Laboratório (FR-030). O cliente simulado não
 * usa LLM: são sequências fixas — determinismo total do lado do cliente.
 * O agente que responde é o REAL (mesmo pipeline do US3).
 */

export type Persona = {
  key: string;
  label: string;
  description: string;
  /** Telefone sintético estável (jamais um número real). */
  phone: string;
  contactName: string;
  script: string[];
};

export const PERSONAS: Persona[] = [
  {
    key: "comprador_decidido",
    label: "Comprador decidido",
    description: "Sabe o que quer e vai direto para a compra.",
    phone: "5210000000001",
    contactName: "[Teste] Comprador decidido",
    script: [
      "Oi, boa tarde",
      "Vocês têm furadeiras sem fio disponíveis?",
      "Perfeito, quanto custa a mais vendida?",
      "Me convenceu, vou comprar. Como eu pago?",
    ],
  },
  {
    key: "pregunton_precios",
    label: "Perguntão de preços",
    description: "Pergunta preço atrás de preço sem se decidir.",
    phone: "5210000000002",
    contactName: "[Teste] Perguntão de preços",
    script: [
      "Oi, qual o preço do martelo?",
      "E a chave de fenda Phillips?",
      "Quanto custa a caixa de pregos de 2 polegadas?",
      "Tem desconto se eu levar várias coisas?",
      "Ok, vou pensar",
    ],
  },
  {
    key: "cliente_enojado",
    label: "Cliente irritado",
    description: "Chega irritado por um problema com a compra.",
    phone: "5210000000003",
    contactName: "[Teste] Cliente irritado",
    script: [
      "Gente, isso é um absurdo",
      "Comprei uma lixadeira semana passada e ela não liga mais, é uma porcaria",
      "Vão me responder ou o quê? Quero uma solução AGORA",
      "Pois espero que sim, porque não vou perder meu dinheiro",
    ],
  },
  {
    key: "fuera_de_kb",
    label: "Pergunta fora do conhecimento",
    description: "Pergunta algo que a base de conhecimento não cobre (fuera_de_kb).",
    phone: "5210000000004",
    contactName: "[Teste] Fora do conhecimento",
    script: [
      "Oi, tenho uma pergunta",
      "Qual é a política de garantia e devolução de vocês?",
      "E se o produto falhar em dois meses, vocês trocam?",
      "Onde eu peço a garantia?",
    ],
  },
  {
    key: "pide_humano",
    label: "Pede um humano",
    description: "Quer ser atendido por uma pessoa (deve encaminhar).",
    phone: "5210000000005",
    contactName: "[Teste] Pede humano",
    script: [
      "Oi",
      "Tenho um assunto delicado com um pedido",
      "Prefiro ser atendido por uma pessoa, quero falar com um humano",
      "Obrigado",
    ],
  },
  {
    key: "errores_modismos",
    label: "Erros e gírias",
    description: "Escreve com erros de ortografia e gírias brasileiras.",
    phone: "5210000000006",
    contactName: "[Teste] Erros e gírias",
    script: [
      "e aí, vocês vendem tinta?",
      "moço, vocês sabem se têm thinner?",
      "quanto custa o galão de tinta branca pra interior",
      "beleza, passo aí na loja daqui a pouco, combinado",
    ],
  },
];

export const PERSONA_LABELS: Record<string, string> = Object.fromEntries(
  PERSONAS.map((p) => [p.key, p.label])
);
