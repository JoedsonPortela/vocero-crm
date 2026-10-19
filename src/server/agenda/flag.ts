/**
 * 015 — Se esta instância tem agenda ou não.
 *
 * Mesma decisão que os canais opcionais (ADR-001): o código do motor
 * viaja sempre na main, e o que decide se ele EXISTE para o usuário é uma
 * variável de implantação. Uma instância normal (sem `AGENDA`) não vê a agenda
 * por nenhum lado: nem tela de Agendamentos, nem aba de Configurações, nem rotas, nem
 * instruções de agendar no prompt do agente — nem se pedem a ela
 * credenciais de ninguém.
 *
 * Foi feito assim, e não com uma branch, porque uma branch precisa se manter
 * compatível com a main E com as demais funcionalidades opcionais, e sua cadeia de
 * migrações diverge sem conserto possível. A prova está no repositório: a branch
 * `004-motor-agenda` ficou irrecuperável em 26 dias.
 *
 * A migração é aplicada sempre: tabelas vazias são inertes, e em troca
 * todas as instâncias compartilham a mesma estrutura.
 *
 * Não se chama `CHANNELS` porque agendar não é um canal: misturar as duas
 * taxonomias faria com que o contrato de capacidades por canal deixasse de
 * significar o que diz.
 */

/** Valores que contam como "ligada". Qualquer outra coisa, desligada. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseAgendaFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Lê-se de `process.env` direto, não por `getEnv()`, igual a
 * `isMockEnabled()` e `isAiConfiguredByEnv()`: perguntar se uma funcionalidade existe não
 * pode depender de todo o ambiente ser validado. Com `getEnv()`, um turno do
 * agente estourava — em vez de degradar — só por consultar a flag.
 *
 * `AGENDA` está declarada no esquema de `lib/env.ts`: ali vive sua
 * documentação e seu tipo. O que não passa pelo validador é esta consulta.
 */
export function agendaEnabled(): boolean {
  return parseAgendaFlag(process.env.AGENDA);
}

/**
 * Resposta para uma superfície de agenda desligada. 404 e não 403 de propósito:
 * se a agenda não estiver ligada, esse endpoint não existe nesta instância —
 * não há nada a revelar sobre ele.
 */
export function agendaDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
