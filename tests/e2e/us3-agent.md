# Roteiro E2E — US3: Agente de IA com ações tipadas

> Conduzido com Playwright (MCP) contra `pnpm dev` com ai-mock
> (`OPENROUTER_BASE_URL` → `/api/dev/ai-mock`) e `AGENT_COALESCE_MS=2000`.

## Preparação

1. Em `/agent`: ligar o interruptor global e adicionar uma entrada P/R à base
   ("¿Hacen envíos?" → "Sí, a todo México en 2-5 días").
   ✅ O contador de tamanho da base reflete a entrada.

## Caminho feliz

2. **Resposta com IA (FR-021)**: entrada "¿hacen envíos a Guadalajara?".
   ✅ Depois do debounce chega UMA resposta do agente marcada "IA" no fio.
3. **Agrupamento (FR-024)**: enviar 2 mensagens seguidas (<2 s entre elas).
   ✅ O agente responde UMA única vez ao conjunto.
4. **move_stage (FR-021)**: entrada "me interesa, lo compro".
   ✅ Resposta do agente + o lead aparece em "Interessado" no kanban.
5. **Transferência por frase (FR-022/SC-006)**: entrada "quiero hablar con un humano".
   ✅ O cliente recebe UM aviso («te comunico com uma pessoa da equipe»), marcado
   como IA, ANTES da transferência — igual ao `farewell` do caminho do modelo. Sem
   ele, quem pediu uma pessoa ficava sem resposta.
   Automatizado em `scripts/e2e-selftest.mjs` (seção FR-022).
   ✅ Selo de atenção humana visível na conversa; a IA fica silenciada (mensagens
   posteriores NÃO recebem resposta, nem outro aviso).
   ✅ "Reativar IA" no painel volta a ligar o agente.

## Caminhos infelizes

6. **Interruptor global desligado (FR-023)**: desligar o agente → entrada → sem
   resposta.
7. **"somos 4 personas"**: NÃO produz transferência (coberto pelo unit test do
   padrão; verificado também com entrada ao vivo).
8. **Sem provedor de IA (FR-026)**: as abas Agente e Laboratório mostram estado
   vazio explicativo com ações desabilitadas e link para Ajustes → IA (verificado
   no checkpoint de compose, onde o ambiente sobe sem token). Com o agente ligado,
   além disso, o aviso «Seu agente ainda não consegue responder» aparece em todo o
   app.

## Ajustes → IA (#85)

> Com o ai-mock: uma chave com sufixo `-invalid` responde 401 e uma com
> `-sin-saldo`, 402 (contrato mocks.md). Sem `OPENROUTER_API_TOKEN` no ambiente,
> para ver o caminho sem reserva.

9. **Configurar pela interface**: em Ajustes → IA escolher «Outro compatível com
   OpenAI», base URL `http://localhost:3000/api/dev/ai-mock`, modelo
   `mock/agente` e uma chave qualquer (ex.: `llave-de-prueba`).
   ✅ «Testar conexão» → «Conexão correta (N ms)» sem salvar nada
   (`GET /api/settings/ai` segue sem credencial).
   ✅ «Trazer modelos» preenche a lista com `mock/agente` e `mock/juez`.
   ✅ «Salvar» → «Chave conectada ••••ueba · Ativo»; o aviso desaparece e a tela
   Agente deixa de pedir configuração. Uma entrada recebe resposta do agente (o
   turno usa a linha, não o ambiente).
10. **Chave recusada (401 → pausa)**: trocar a chave por `llave-invalid` e salvar
    (volta a «Ativo»: salvar sempre reativa). Enviar uma entrada.
    ✅ Depois do turno, `GET /api/settings/ai` → `estado: paused_invalid_token`
    com `motivo` do provedor; a aba diz «Pausado: chave recusada» e o aviso
    «Seu agente está pausado: o provedor recusou sua chave».
    ✅ Outra entrada NÃO gera chamada ao provedor (o agente se cala).
    ✅ «Testar conexão» com a chave salva → 422 `invalid_token`.
11. **Sem saldo (402)**: igual com `llave-sin-saldo` → `paused_no_credit`,
    «Pausado: sem saldo», e o aviso pede para recarregar e testar a conexão.
12. **Recuperação**: colar uma chave válida e salvar → `active`; ou, com a salva,
    «Testar conexão» quando o provedor voltar a aceitá-la → «Sua chave voltou a
    ficar ativa».
13. **Remover**: «Remover» apaga a linha. Com `OPENROUTER_API_TOKEN` no ambiente, a
    tela diz que hoje responde com as variáveis do ambiente (••••last4) e o agente
    segue; sem ele, volta o estado vazio.
