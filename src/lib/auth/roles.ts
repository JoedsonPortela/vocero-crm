/**
 * Quem pode CONFIGURAR a instância: conectar o número, colar a chave de
 * IA, escrever o agente, ligá-lo. Na raiz são dois papéis: o `owner`
 * que cria a organização no primeiro registro e o `admin` que o Better Auth
 * conhece (hoje ninguém o atribui, mas é um papel de configuração e não de
 * operação). Um `member` da equipe atende a Bandeja: não pode fazer
 * nenhum dos passos do guia inicial, então não lhe é mostrado.
 *
 * Vive em `lib/` porque os dois lados consultam: o menu (cliente) e o
 * redirecionamento da raiz (servidor).
 */
export function canConfigure(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
