# Roteiro E2E — Um envio que falha deve dizer POR QUÊ

> Automatizado em `scripts/e2e-send-failure.mjs` (15 checks, Playwright contra
> `pnpm dev` com wa-mock). Nasce de um caso real em produção.

## A falha original

Foi enviado um modelo **aprovado** para um número real e o operador só viu um
triângulo vermelho, sem explicação. A Meta tinha dito o motivo no webhook de
status:

```json
{ "code": 130472, "title": "User's number is part of an experiment" }
```

O CRM guardava isso em `message.error` desde o início… e não o expunha em lugar
nenhum: nem em `MessageDto`, nem no evento SSE `message.status`, nem no fio. O
operador não tinha como saber se o problema era dele ou da Meta.

## Caminho verificado

1. Enviar uma mensagem para uma conversa com a janela aberta.
   ✅ Fica `pending` e o DTO já traz o campo `error` (em `null`).
2. A Meta responde `failed` com `errors[0].code = 130472`
   (`POST /api/dev/wa-mock/status` com `errorCode`/`errorMessage`).
   ✅ A mensagem passa a `failed`.
   ✅ `error` explica o motivo **em português** ("…está em um experimento…"),
   sugere a saída (usar um modelo **UTILITY**) e mantém o código
   `(Meta 130472)` para rastrear na documentação.
3. Abrir o fio na Bandeja.
   ✅ Sob a bolha aparece «**Não foi entregue.** …», não um triângulo mudo.
4. Um segundo envio falha com 131049 com o fio aberto.
   ✅ O motivo aparece **sem recarregar**: o evento SSE `message.status` agora
   viaja com `error`.

## Regras do tradutor (`lib/meta/send-errors.ts`)

- Código conhecido → frase acionável em português + `(Meta <código>)`.
- Código desconhecido → texto cru da Meta + código, nunca se perde.
- Sem código nem texto (ou texto em branco) → "A Meta recusou o envio".
  ⚠️ Com `??` em vez de `||` isto devolvia string vazia: um erro tão mudo quanto
  o triângulo. Coberto em `tests/unit/send-errors.test.ts`.

## Armadilha do harness

O wa-mock numerava suas saídas `wamid.mock.out.<n>` com um contador que reinicia
com o processo, enquanto o banco guarda as mensagens de execuções anteriores → o
UNIQUE de `wa_message_id` estourava com 500 ao enviar. Agora o id leva um carimbo
por inicialização, e a outbox expõe o `waMessageId`, para não adivinhar seu
formato a partir dos testes.
