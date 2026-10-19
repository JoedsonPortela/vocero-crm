/**
 * 016 — Se esta instância atribui anúncios e reporta conversões à Meta.
 *
 * Mesmo tratamento dos canais opcionais (ADR-001) e da agenda (ADR-002): o
 * código viaja sempre na `main` e o que decide se ele EXISTE para o usuário é
 * uma variável de implantação. Uma instância que não anuncia não vê isto por
 * nenhum lado: nem aba de Configurações, nem rotas, nem uma credencial a pedir.
 *
 * O que a bandeira desliga e o que não desliga (decisão do dono, 2026-09-21, spec 018):
 *
 * - NÃO desliga a ORIGEM do anúncio. Que uma conversa veio do anúncio A,
 *   com seu título e seu criativo, é guardado e sempre visto na caixa de entrada: o
 *   dado viaja dentro do webhook que a instância já recebe, não pede
 *   credenciais nem chama ninguém, e é inerte se nunca chegar um anúncio.
 * - SIM desliga o `ctwa_clid`, além do envio à Meta e da aba de Configurações.
 *   O identificador de clique chega de graça no webhook, e guardá-lo "por via das
 *   dúvidas" faria com que ligar a bandeira meses depois tivesse histórico a
 *   reportar — mas encher uma tabela com identificadores de clique da Meta numa
 *   instância que nunca pediu essa função quebra a promessa do ADR-001 pelo
 *   lado que mais importa, o dos dados. Sem a bandeira o anúncio é
 *   guardado sem ele, nem na sua coluna nem dentro do `raw`. O custo (ligar
 *   atribui daí em diante) é menor do que parece: a janela de
 *   atribuição da Meta é medida em dias, não em meses.
 *
 * A migração é aplicada sempre: tabelas vazias são inertes, e em troca
 * todas as instâncias compartilham a mesma estrutura.
 */

/** Valores que contam como "ligada". Qualquer outra coisa, desligada. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseAtribucionFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Lê-se de `process.env` direto, não por `getEnv()`, igual a
 * `agendaEnabled()` e `isMockEnabled()`: perguntar se uma funcionalidade existe não
 * pode depender de todo o ambiente ser validado. A ingestão de uma mensagem
 * consulta esta bandeira (para decidir se guarda o `ctwa_clid`), e um ambiente
 * meio configurado deve degradar — não estourar — justo ali.
 *
 * `ATRIBUCION` está declarada no esquema de `lib/env.ts`: ali vivem sua
 * documentação e seu tipo. O que não passa pelo validador é esta consulta.
 */
export function atribucionEnabled(): boolean {
  return parseAtribucionFlag(process.env.ATRIBUCION);
}

/**
 * Resposta para uma superfície desligada. 404 e não 403 de propósito: se a
 * bandeira estiver desligada, esse endpoint não existe nesta instância — não há nada
 * a revelar sobre ele.
 */
export function atribucionDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
