# E2E — Canal do TikTok pelo Zernio (022)

Chicote: `scripts/e2e-tiktok.mjs`. Spec:
[`specs/022-canal-tiktok/spec.md`](../../specs/022-canal-tiktok/spec.md).

Pré-condição: app rodando (`next dev`) sobre uma base migrada, **sem**
`BRAIN_DISPATCH_URL` (responde o agente incluído), com `CHANNELS` incluindo
`tiktok` (e `instagram`, para a divisão por plataforma), mocks
(`WA_MOCK_ENABLED=true`, `ZERNIO_BASE_URL` → zernio-mock, `OPENROUTER_BASE_URL`
→ ai-mock com `OPENROUTER_API_TOKEN` e `OPENROUTER_MODEL`), `BOT_API_KEY`
(≥16) e `AGENT_COALESCE_MS=1500`.

O chicote faz de **Zernio**: entrega eventos `message.received` com o formato da
documentação deles, assinados com o segredo da conta (`x-zernio-signature`,
HMAC-SHA256 em hex do corpo cru), e lê do mock o que o CRM mandou de volta (`GET
/api/dev/zernio-mock/_sent`).

```bash
node --env-file=.env scripts/e2e-tiktok.mjs
```

## Conectar

1. **AC14** `PUT /api/settings/tiktok` com uma chave que o Zernio recusa → 422
   `invalid_token`, e não é salva. Com uma boa → 200. `GET` mostra o `accountId`,
   o usuário sem arroba, `status = connected`, que há segredo e só os últimos 4
   da chave; nem a chave nem o segredo aparecem.
2. **AC15** `GET /api/settings/webhook` → `tiktokUrl` termina em
   `/api/webhooks/tiktok/<token>`. `/api/health` lista `tiktok`.

## Receber

3. **AC2** Segmento da URL errado → 404. Assinatura inválida → 401. Nenhum dos
   dois deixa nada na bandeja.
4. **AC1** Assinatura válida → 200, e a conversa aparece com o nome do perfil,
   canal `tiktok` e o texto do cliente. Por `/api/bot/context`, a identidade é
   `tt:<id>` e a janela está aberta com mais de 24 h pela frente.
5. **AC3** O mesmo evento outra vez → 200 e continua havendo uma única mensagem de
   entrada.

## Responder

6. **AC8** O agente incluído responde: a mensagem nasce `sent` (o TikTok não manda
   confirmações) e o Zernio a recebeu no `conversationId` desse cliente, com o
   `accountId` e sem etiqueta.
7. **AC7** O operador responde pela bandeja e chega ao Zernio.

## Os limites do TikTok

8. **AC10** Com duas saídas já (agente e operador), as mensagens 3 a 10 saem. A
   **décima primeira** → 409 `message_limit`, com um texto que diz «10
   mensagens» e «escreva de novo»; não chega ao Zernio nem fica na conversa. Por
   `POST /api/bot/messages`, o mesmo 409 `message_limit`.
9. **AC11** O cliente volta a escrever: o agente responde e o operador volta a
   poder enviar.
10. **AC9** 6.001 caracteres → 422 com o limite dito, sem chamar o Zernio; 6.000
    caracteres com acento (12.000 bytes) saem. Por `/api/bot/messages`, 6.001 →
    422 `invalid_body`.
11. **AC12** Uma mensagem enviada há 30 horas: a janela segue aberta e pode-se
    responder. Uma de há 49 horas: fechada, e responder → 409 `window_closed` com
    um texto que diz que o TikTok não permite reabri-la; nada sai pelo Zernio.

## O que é descartado

12. **AC4** Um evento de outra conta, de outra plataforma (X), de saída, de outro
    tipo (`message.sent`) ou um corpo que não é JSON → 200 e nenhuma conversa nova.
13. **AC6** Um anexo sem texto entra com o seu tipo (`image`).
14. **AC5** O mesmo evento do TikTok entregue a `/api/webhooks/ig/<token>` entra
    como conversa do TikTok.

## Em outros chicotes e testes

- **AC8, com cérebro externo**: `scripts/e2e-despacho.mjs` (seção «022·AC8»)
  confere que o turno é despachado com `channel: "tiktok"`, identidade `tt:` e
  `windowExpiresAt` em 48 h, e que o cérebro responde por `/api/bot/messages`.
- **AC13** (o agente bate no teto e não repassa): o agente incluído manda uma
  mensagem por turno e cada entrada reinicia a contagem, então não dá para
  provocar de fora. Coberto por `tests/unit/handoff-ack.test.ts`.
- **AC16** (canal desligado → 404) e **AC17** (os outros canais não mudam): a
  configuração `default` do CI, `tests/unit/tiktok.test.ts`,
  `scripts/e2e-messenger.mjs` e `scripts/e2e-selftest.mjs`.
- **AC18** (Laboratório): `tests/unit/lab-sandbox.test.ts` e
  `tests/unit/send-sandbox.test.ts`.

## Conferências à mão

- **A tela.** Com `tiktok` em `CHANNELS`, Ajustes → Canais mostra «TikTok»: antes
  as regras do TikTok, depois o formulário e, já conectada, a URL do webhook. Sem
  o canal, `/settings/tiktok` dá 404 e o link não existe.
- **O distintivo.** Na bandeja, uma conversa do TikTok leva o seu mosaico preto e
  pode ser filtrada por canal.
- **O compositor.** Numa conversa do TikTok com a janela fechada, no lugar do
  seletor de modelos diz que o TikTok não permite reabri-la.
- **AC19 — atualizar.** Sobre uma base em `0017`, o migrador aplica `0018` e cria
  `tiktok_credentials` vazia; o resto não muda.
