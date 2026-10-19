# E2E — Texto do agente nas redes e janela humana (024)

Chicote: `scripts/e2e-ventana-social.mjs`. Spec:
[`specs/024-texto-social-ventana-humana/spec.md`](../../specs/024-texto-social-ventana-humana/spec.md).

Pré-condição: app rodando (`next dev`) sobre uma base migrada, **sem**
`BRAIN_DISPATCH_URL`, com `CHANNELS=whatsapp,instagram,messenger,tiktok`,
simuladores (`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock,
`ZERNIO_BASE_URL` → zernio-mock, `OPENROUTER_BASE_URL` → ai-mock com
`OPENROUTER_API_TOKEN` e `OPENROUTER_MODEL`), `BOT_API_KEY` e
`AGENT_COALESCE_MS=1500`.

O chicote faz de **cliente** (entrega eventos assinados do Zernio; com `sentAt`
antigo para envelhecer a janela), de **cérebro** (`POST /api/bot/messages`) e de
**pessoa** (a bandeja), e lê o que saiu para cada plataforma
(`/api/dev/zernio-mock/_sent`, `/api/dev/wa-mock/outbox`).

```bash
node --env-file=.env scripts/e2e-ventana-social.mjs
```

## D1 — O texto da IA sai liso nas redes

1. Pelo Instagram, Messenger e TikTok: o cérebro manda um texto com negrito,
   itálico, tachado, marcadores e um link de Markdown → 200. Para a plataforma
   chega sem marcas, com `•` nos marcadores e o link como `texto: URL`. No fio
   fica esse mesmo texto, marcado como IA.
2. O que uma pessoa escreve na bandeja, com asteriscos → sai tal como está.
3. Pelo WhatsApp o mesmo texto do cérebro sai com a sua formatação e assim é
   salvo.

## D3 — Quem pode escrever depois de 24 horas (Instagram e Messenger)

4. **23 horas**: a bandeja a considera aberta; a resposta sai sem etiqueta.
5. **30 horas**: `windowOpen: false` e `humanWindow.open: true` com uns 6 dias
   pela frente. A IA → 409 `window_closed` que diz que só responde uma pessoa, e
   para a plataforma não sai nada. Uma pessoa → 200, com `MESSAGE_TAG` /
   `HUMAN_AGENT`. Responder não estende o prazo.
6. **8 dias**: `humanWindow.open: false`. Nem a pessoa (409 `window_closed` que diz
   7 dias) nem a IA. Não sai nada.
7. O cliente volta a escrever → a janela reabre e a IA responde.

## Os outros canais não mudam

8. TikTok às 30 horas: `humanWindow: null`, a sua janela de 48 horas segue aberta
   e a IA responde. WhatsApp: `humanWindow: null`.

## O agente incluído

9. Com o agente ligado, um cliente escreve pelo Instagram com asteriscos. O
   simulador de IA repete o que ele disse: a resposta do agente chega ao Instagram
   sem as marcas, e sem etiqueta.

## Interface (à mão, claro e escuro)

- Conversa do Instagram às 30 horas: a caixa de texto está, com o aviso «Só uma
  pessoa pode responder», o rodapé «Janela humana · restam 5 dias» e o cabeçalho
  «janela humana».
- Aos 8 dias: aviso de janela fechada, sem caixa de texto nem modelos.
- Dentro de 24 horas: como sempre, «Janela aberta · restam …».
