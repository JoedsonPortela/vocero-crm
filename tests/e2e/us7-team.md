# Roteiro E2E — US7: Multiusuário mínimo

> Conduzido com Playwright (MCP) contra `pnpm dev` (organização já criada).

1. **Cadastro fechado (FR-060)**: POST público de cadastro com outra conta.
   ✅ 403 com mensagem clara (a UI a mostra em /register).
2. **Escape**: `ALLOW_SIGNUP=true` reabre o cadastro (unit test
   registration.test.ts; exige reinício com a variável).
3. **Conta de equipe (FR-061)**: o proprietário cria uma conta em
   Configurações → Equipe (e-mail + senha temporária mostrada uma vez).
   ✅ O novo membro consegue entrar e vê a bandeja da organização.
   ✅ Um membro (não proprietário) NÃO pode criar contas (403).
4. **Limite de tentativas (FR-062)**: mais de 10 logins com falha do mesmo IP em
   10 min.
   ✅ 429 "Tentativas demais".
