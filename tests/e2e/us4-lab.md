# Roteiro E2E — US4: Laboratório (SEMPRE contra ai-mock, determinístico)

> Conduzido com Playwright (MCP) contra `pnpm dev` com ai-mock. A base inicial
> NÃO cobre garantias/devoluções (lacuna intencional do roteiro).

## Preparação

1. `DELETE /api/dev/wa-mock/outbox` — a outbox deve continuar VAZIA no fim.
2. Agente configurado (US3) e provedor de IA (mock) ativo.

## Execução 1

3. Em `/lab`: apertar "Rodar avaliação".
   ✅ A UI mostra o subtítulo permanente "Sandbox interno — não envia mensagens
   reais", progresso ao vivo (n/6) sem bloquear a navegação.
4. Ao terminar:
   ✅ Relatório com score global (5 verdes + 1 vermelho ≈ 83), cartão da persona
   "Pergunta fora do conhecimento" com achado `fuera_de_kb`, evidência e
   sugestão; transcrição visível por persona.
   ✅ A persona "Pede um humano" terminou em transferência (roteiro cortado).
   ✅ `GET /api/dev/wa-mock/outbox` → VAZIO (nenhuma mensagem saiu para o WhatsApp).
   ✅ As conversas de teste NÃO aparecem na bandeja.

## Fechar o loop

5. No achado: "Adicionar ao conhecimento" → editar/confirmar → salvo na base
   (visível em `/agent`).
6. Rodar a avaliação de novo.
   ✅ O histórico mostra 2 execuções; a nova com score 100 e delta +17.

## Caminhos infelizes

7. Com uma execução em curso, `POST /api/lab/runs` → 409 `run_in_progress`.
8. Execuções órfãs: coberto por `src/instrumentation.ts` no boot (verificação no
   checkpoint de compose, onde o servidor reinicia).
