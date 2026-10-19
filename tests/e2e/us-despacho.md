# E2E — Despacho padrão: o CRM entrega cada turno ao cérebro (021, #89; 025)

Chicote: `scripts/e2e-despacho.mjs`. Contrato:
[`specs/021-despacho-estandar/contracts/despacho.md`](../../specs/021-despacho-estandar/contracts/despacho.md).

Pré-condição: app rodando (`next dev`) sobre uma base migrada, com mocks
(`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock, `OPENROUTER_BASE_URL`
→ ai-mock com `OPENROUTER_API_TOKEN` e `OPENROUTER_MODEL`), `BOT_API_KEY`
(≥16), `AGENT_COALESCE_MS=1500` e
`BRAIN_DISPATCH_URL=http://127.0.0.1:<porta livre>/vocero/dispatch`. Para os
outros canais, `CHANNELS=whatsapp,instagram,messenger` e `ZERNIO_BASE_URL` →
zernio-mock.

O chicote faz de **cérebro**: levanta um servidor HTTP nessa URL, no seu próprio
processo, verifica a assinatura de cada despacho sobre o corpo cru e responde
por `/api/bot/messages`. O turno atravessa HTTP de verdade nos dois sentidos.

```bash
node --env-file=.env scripts/e2e-despacho.mjs
```

**Dois modos (025).** O chicote olha como a app foi iniciada. Com
`BRAIN_DISPATCH_URL` roda todo este roteiro. Sem ela responde o agente
incluído, e roda só a seção «Sem cérebro externo» do final (não precisa de
`BOT_API_KEY`). O gate completo são as duas execuções, cada uma com a app
iniciada no seu modo.

## Setup

1. Cadastro ou login do operador e conexão de WhatsApp (wa-mock).
2. Interruptor do agente incluído **ligado**, com provedor de IA: teria com que
   responder.
3. `GET /api/agent/brain-status` → `dispatch.active = true`, `problem = null`;
   `embedded.silenced = true`, `embedded.answering = false`; `warning = null`.

## História 1 — Uma mensagem chega ao cérebro

4. **AC1** Uma mensagem de WhatsApp de entrada aparece na bandeja e, passada a
   janela, o cérebro recebe **um** `POST`: assinatura `x-vocero-signature` válida
   sobre o corpo cru com `BOT_API_KEY`; cabeçalhos `x-vocero-dispatch-id` (igual
   ao `dispatchId`, `dsp_…`) e `x-vocero-organization`; sem `x-vocero-event`; as
   chaves do evento na ordem do contrato; `conversation.id` é a da bandeja,
   `channel = whatsapp`, janela aberta; uma mensagem de texto sem anexo. O corpo
   não leva o token do WhatsApp nem a chave.
5. `GET /api/bot/context?conversationId=…` → 200, e a identidade do evento é a
   que devolve o contexto.
6. `POST /api/bot/messages` com esse `conversationId` → 200 e a resposta está na
   outbox do wa-mock.
7. **AC10** Passada outra janela, a única saída da conversa é a do cérebro: o
   agente incluído não respondeu. O cérebro recebeu o turno uma única vez.
8. **AC2** Cinco mensagens seguidas de outro contato → **um** despacho com as
   cinco, em ordem.
9. **AC5** Com o cérebro levando 3 s para confirmar recebimento, chega uma segunda
   mensagem enquanto o primeiro despacho está em voo → chega um **segundo**
   despacho, com outro `dispatchId`, que traz as duas mensagens.
    Cada mensagem da rajada do passo 8 é esperada na bandeja antes de mandar a
    seguinte: o webhook responde 200 e depois ingere, e sem essa espera a ordem em
    que são salvas não é a ordem em que foram enviadas.

### 025 — O despacho lembra o que deve

- **025·AC1** O cérebro confirma o recebimento da primeira mensagem e «pensa».
  Entra uma segunda mensagem; com a janela dela ainda aberta, o cérebro responde a
  primeira por `/api/bot/messages`. Passada a janela chega um **segundo
  despacho**, assinado e com outro `dispatchId`, com **exatamente** essa segunda
  mensagem (por id): nem vazio nem repetindo a já respondida.
- **025·AC2** Depois de outra janela não há um terceiro despacho, a conversa
  segue com a IA ligada e sem repasse, e `dispatch.pending = 0`.
- **025·AC4** Entra uma mensagem e, com a janela aberta, o operador responde pela
  bandeja (`POST /api/conversations/{id}/messages`). O cérebro não recebe
  **nada**: nem essa mensagem nem um despacho vazio.
- **025·AC5** `dispatch.pending = 0`, `dispatch.lastFailure` não mudou e a
  conversa não passou para uma pessoa. A próxima mensagem desse cliente sim é
  despachada, e o evento traz só ela.

Os dois casos dependem de ganhar da janela de agrupamento. Se o roteiro perder
essa corrida (máquina carregada), tenta de novo com outro contato, até três
vezes, e diz isso; não segue com um caso que já não prova nada.

10. **AC4** Uma imagem com legenda → o evento traz `mediaId`, `mimeType` e
    `caption`, e `GET /api/bot/media/{mediaId}` devolve a imagem.
11. **AC3** Uma mensagem de Messenger (pela Meta) e uma de Instagram (pelo Zernio)
    são despachadas com o seu `channel` e a sua identidade (`fb:…`, `ig:…`). O
    evento não diz por qual provedor entrou. O cérebro responde a de Messenger
    pelo mesmo `/api/bot/messages`.

## História 3 — Quem responde

12. **AC11** Com a IA pausada numa conversa
    (`PATCH /api/conversations/{id} {aiEnabled:false}`), uma mensagem nova fica
    na bandeja e **não** chega ao cérebro.
13. **AC11** Pausar a IA *durante* a janela, com o despacho já enfileirado: o
    `PATCH` responde bem com a janela ainda aberta (verifica-se à parte: senão o
    despacho sairia — como deve — e o vermelho seria do roteiro), não é entregue,
    a conversa **não** fica repassada com motivo `error` e `dispatch.pending = 0`.
14. **AC13** Uma execução completa do Laboratório termina e nenhum cliente
    simulado chega ao cérebro.

## História 2 — O cérebro falha

15. **AC6/AC7** Com o cérebro respondendo 500: a mensagem está na bandeja; chegam
    **três** tentativas do **mesmo** `dispatchId`, assinadas, com ~1 s e ~4 s
    entre elas, e não há uma quarta; a conversa passa para uma pessoa
    (`aiEnabled = false`, `handoffReason = "error"`); `brain-status` mostra
    `dispatch.lastFailure` com o 500. Uma mensagem posterior desse contato já não
    é despachada.
16. **AC8** Com o cérebro respondendo 422: **uma** tentativa e para uma pessoa.
17. **AC6** Com o cérebro desligado (conexão recusada): para uma pessoa, e o
    motivo é «não foi possível conectar com o cérebro», sem URL nem chave.
18. O cérebro volta: um cliente novo é despachado, e `lastDeliveredAt` fica
    posterior a `lastFailure.at`.

## História 4 — «Quem responde»

19. **AC14–AC16** `GET /api/agent/brain-status` → `dispatch.active`, `host`
    igual a host:porta da URL, `lastDeliveredAt`, `pending = 0`. A resposta não
    contém o caminho da URL nem a chave. As chaves de antes (`embedded.answering`,
    `external.active`, `external.lastSeenAt`, `warning`) continuam. Sem sessão →
    401.

## Sem cérebro externo — o agente incluído (025)

App iniciada **sem** `BRAIN_DISPATCH_URL`, com os mesmos mocks. O mock de IA é
configurado por `GET /api/dev/ai-mock/v1/chat/completions?demoraMs=…&reset=1` e
devolve o que lhe perguntaram (`peticiones`, sem o prompt de sistema).

20. `GET /api/agent/brain-status` → `dispatch.active = false`,
    `embedded.answering = true`.
21. **025·AC6** Com o modelo levando 5 s, entra uma mensagem; quando o modelo já a
    recebeu e segue pensando, entra uma segunda. O agente gasta **um** turno a
    mais: duas requisições ao modelo no total, também depois de esperar outra
    janela (não entra em loop).
22. **025·AC7** Na segunda requisição o modelo lê: cliente (primeira mensagem),
    agente (sua resposta), cliente (segunda mensagem).
23. **025·AC8** A conversa tem duas saídas, uma por pergunta.
24. **025·AC5b** Entra uma mensagem e, com a janela aberta, o operador responde
    pela bandeja: o modelo não recebe nenhuma requisição por essa mensagem, a
    única saída é a da pessoa e a IA segue ligada. A próxima mensagem do cliente
    sim é respondida pelo agente.
25. `dispatch.pending = 0`: nada disso passou pela outbox.

**025·AC9** (uma mensagem que entra com o turno já iniciado mas antes de abrir o
histórico é respondida nesse turno) é uma janela de milissegundos que o roteiro
não consegue provocar: quem cobre é `quedanDebidos` em
`tests/unit/orden-turno.test.ts`.

## Verificações à mão

- **025·AC11 — atualizar desde a 1.5.** Sobre uma base migrada até `0016`, com
  uma linha `pendiente` em `dispatch`: o migrador aplica `0017` (duas passadas,
  a segunda sem efeito), a linha fica com `message_ids` nulo, e com a app
  iniciada o cérebro recebe esse despacho com sua mensagem e a linha passa a
  `entregado`.

- **AC9 — retomar depois de um reinício.** Com a app parada, inserir uma linha
  `pendiente` em `dispatch` (com `not_before` já vencido) para uma conversa cujo
  último mensagem é do cliente; deixar um cérebro escutando; iniciar a app. Sem
  que entre nenhuma mensagem, o cérebro recebe esse `dispatchId` assinado e a
  linha fica `entregado`. O log diz `[boot] despacho al cerebro activo → <host>`.
- **AC12 — sem a variável nada muda.** Tirar `BRAIN_DISPATCH_URL`, reiniciar
  sobre uma base nova e rodar `pnpm test:e2e`: o agente incluído responde como
  antes e a tabela `dispatch` fica vazia.
- **AC16 — mal configurado.** Com `BRAIN_DISPATCH_URL` sem `BOT_API_KEY`, ou com
  algo que não é uma URL: o log de inicialização diz, `pnpm doctor` marca com `!`
  e o conserto, o cartão mostra «Não é possível despachar», e o agente incluído
  segue respondendo.
- **O cartão.** Na tela Agente, a linha «Despacho ao cérebro» diz
  «Ativo · host» com a última entrega; depois de um turno que não chegou, passa
  para âmbar com o motivo; a linha do agente incluído diz que está em silêncio.
