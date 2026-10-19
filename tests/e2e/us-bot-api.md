# E2E — API de serviço para um cérebro externo (`/api/bot/*`)

Pré-condição: app rodando com mocks (`WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock), organização criada, conexão WhatsApp salva e
`BOT_API_KEY` configurada (≥16 caracteres).

Esta superfície NÃO é usada pelo navegador: é usada por um bot próprio do
operador que quer conduzir a conversa sem que o token do WhatsApp saia do CRM. O
agente in-process do Vocero pode ficar desligado.

## Autorização

1. `GET /api/bot/media/media123` SEM o header `X-API-Key` → **401** `unauthorized`.
2. O mesmo com uma chave errada → **401** (mesmo corpo: não revela se a chave
   existe ou não).

## Presença: marcar como lido + "digitando…"

3. Provocar uma entrada (`POST /api/dev/wa-mock/inbound`) e pegar o
   `conversationId` de `GET /api/conversations`.
4. `POST /api/bot/typing {conversationId}` com a chave → **200** `{ok: true}`.
5. `GET /api/dev/wa-mock/outbox` → a contagem NÃO mudou: marcar como lido e o
   indicador não são mensagens de saída e não contaminam a bandeja.
6. Pausar a IA dessa conversa (alternância do painel, ou
   `PATCH /api/conversations/{id} {aiEnabled:false}`) e repetir o typing →
   **200** `{ok:false, reason:"ai_paused"}` e a Meta nem é tocada: com um humano
   atendendo, "digitando…" mentiria ao cliente.
7. Conversa do Laboratório (`is_test`) → `{ok:false, reason:"sandbox"}`.

## Proxy de mídia

8. `GET /api/bot/media/media123` com a chave → **200**, `content-type: image/*`
   e corpo não vazio. O token do WhatsApp nunca viajou ao bot.
9. `GET /api/bot/media/media-inexistente` quando o Graph responde 404 → **404**
   `media_meta_failed` (não 500).

## Reinício da conversa de testes

10. Com a conversa em handoff (`aiEnabled:false`), `POST /api/bot/reset
    {conversationId}` com a chave → **200** `{ok:true}`.
11. `GET /api/conversations` → essa conversa volta com `aiEnabled: true` e sem
    `handoffAt`; o lead está na PRIMEIRA etapa do pipeline.
12. O histórico de mensagens da bandeja continua completo: o reset é de estado,
    não apaga a auditoria.
13. `POST /api/bot/reset` sem chave → **401**.

## Perfil do agente e base de conhecimento

O bot externo não adivinha o negócio: lê das mesmas duas telas que o dono edita
(Agente e a base de conhecimento). Este endpoint é o contrato.

14. `GET /api/bot/profile` com a chave → **200** com a forma exata
    `{profile: {name, tone, instructions, escalationRules, greeting}, kb, resources}`.
    Os cinco campos do perfil coincidem com o salvo na tela Agente; os opcionais
    vazios viajam como `null`, não como string vazia.
15. `kb` é a base de conhecimento já renderizada (`P:`/`R:` para as perguntas,
    os blocos tal como estão, na ordem da tela). Com a base vazia viaja a string
    canônica `(base de conhecimento vazia)`, não `null`: o bot pode injetá-la no
    seu prompt sem ramificar.
16. `profile.enabled` NÃO vem, nem com a IA in-process ligada nem desligada: esse
    flag governa o agente do Vocero, não o cérebro externo, que é pausado por
    conversa (`aiEnabled` e os handoffs).
17. Editar o tom na tela Agente e pedir o perfil de novo → a mudança já está: a
    resposta não é cacheada.

## Contexto da conversa

O que só o CRM sabe: quem é a pessoa, se um humano assumiu o controle e se a
janela de 24 h ainda está aberta. O histórico de mensagens NÃO viaja: essa
memória é do bot.

18. `GET /api/bot/context?conversationId={id}` com a chave → **200** com
    `contact` (id, name, waIdentity, phone), `conversation`
    (id, aiEnabled, handoffAt, windowOpen, windowRemainingMs) e `lead`
    (id, stageName).
19. `GET /api/bot/context?waIdentity={identidade}` → a MESMA conversa. É o caminho
    que o bot usa quando chega uma mensagem e só tem o remetente.
20. Depois de uma entrada recente, `windowOpen: true` e `windowRemainingMs` > 0.
21. Com a conversa em handoff, `aiEnabled` vem em **false** mesmo que o flag da
    linha continue true: para o bot há uma só verdade.
22. Uma conversa do Laboratório nunca é resolvida por `waIdentity`: o bot de
    produção não deve falar com um cliente simulado.

**As consultas do contato (015).** Com `AGENDA=on` o contexto traz também
`booking`: `timezone`, `next` (a próxima agendada), `unresolved` (a que já
começou e ninguém fechou, até 7 dias) e `lastClosed` (a última fechada em 7
dias). Com a agenda desligada `booking` **não vem**, nem vazio. É aditivo: um
bot que não o lê não muda. As consultas de teste nunca aparecem. A forma
completa está em
[`specs/015-motor-agenda-universal/contracts/agenda.md`](../../specs/015-motor-agenda-universal/contracts/agenda.md);
os casos com consultas, em [`us-agenda.md`](us-agenda.md).

## Ficha de qualificação

O que o bot vai descobrindo do lead. As chaves quem define é o negócio: o CRM
não impõe um questionário.

23. `PUT /api/bot/ficha {conversationId, ficha}` com a chave → **200** com a ficha
    COMPLETA resultante (não só o patch), e essa mesma ficha aparece em
    `contact.ficha` do contexto do turno seguinte.
24. Um segundo PUT com outras chaves **as soma**: o que não vem é preservado. Um
    `null` explícito **apaga** essa chave.
25. Valores que o CRM não consegue guardar — objetos, arrays, strings vazias,
    números não finitos — são ignorados em silêncio e o resto é salvo: um 422
    jogaria fora, para o bot, dados de qualificação que já custaram uma conversa.
26. Conversa inexistente → **404**. Corpo sem `ficha` → **422**.

## O bot envia pelo CRM

27. `POST /api/bot/messages {conversationId, text}` com a chave → **200**
    `{messageId}`, a mensagem aparece na bandeja marcada como IA
    (`aiGenerated: true`, `origin: "ai"`) e sai pelo canal do WhatsApp. O token da
    Meta nunca viajou ao bot.
28. Com a IA pausada (handoff), o mesmo envio → **409** `ai_paused` e a outbox
    NÃO muda: a recusa acontece antes de tocar a Meta.
29. Com a janela de 24 h fechada → **409** `window_closed`. O bot não consegue
    contornar a regra da Meta; para isso existe o envio de modelo pelo app.
30. Numa conversa do Laboratório → **409** `sandbox_violation`.

## O bot pede um humano

31. `POST /api/bot/handoff {conversationId, reason}` com a chave → **200**, a
    conversa fica com `aiEnabled: false`, seu `handoffAt` e o motivo. Na bandeja
    aparece na hora, sem recarregar (mesmo evento da alternância).
32. Repetir é idempotente: não sobrescreve a hora nem o motivo do primeiro.
33. Um `reason` que não está no catálogo — ou ausente — **não derruba o handoff**:
    cai em `modelo` e a IA pausa do mesmo jeito. Um 422 aqui deixaria o bot
    vendendo para alguém que acabou de pedir um humano.
34. Conversa inexistente → **404**.

## Caminho infeliz

35. `GET /api/bot/profile` numa instância sem perfil de agente → **404**
    `no_profile` (condição esperada, não um 500: o bot cai no seu brief local).
36. `GET /api/bot/context` sem `waIdentity` nem `conversationId` → **422**; com um
    `conversationId` que não existe → **404**.
37. `POST /api/bot/messages` com texto vazio → **422**.
38. `POST /api/bot/typing` com um `conversationId` inexistente → **404**.
39. Com a Meta fora do ar (token `...-invalid` no mock), typing → **200**
    `{ok:false, reason:"meta_error"}`: é best-effort por contrato, e ao bot jamais
    vale tentar de novo.

## Quem responde aos seus clientes

O cartão no topo da tela Agente (`GET /api/agent/brain-status`). Para os passos
do `/health`, a app roda com `BRAIN_HEALTH_URL` apontando para uma porta local
onde o roteiro levanta uma Nea falsa (com credenciais e query de teste na URL).

40. Sem sessão → **401**. Com sessão → `embedded`, `external` e `warning`;
    `external.keyConfigured: true` (há `BOT_API_KEY`).
41. Uma chamada a `/api/bot/*` com chave errada NÃO move
    `external.lastSeenAt`; `GET /api/bot/context` com a chave sim, e o cérebro
    externo fica `active: true`.
42. Com a Nea falsa saudável: `health.reachable: true` com `version`, `mode` e
    `relay.pendientes`; `health.host` é só o host, e nem as credenciais nem a
    query da URL aparecem na resposta (à Nea elas chegam, como
    `Authorization: Basic`). Três consultas seguidas = zero pedidos novos à Nea
    (cache de 15 s).
43. Com provedor de IA (Ajustes → IA ou ambiente) e o agente incluído ligado →
    `warning: "doble_respuesta"` e o aviso vermelho no cartão. Desligá-lo tira o
    aviso.
44. Com a Nea falsa travada: em ≤ 4 s a consulta volta com `reachable: false`,
    `problem: "timeout"`; a chamada recente continua contando como ativa.
45. Na bandeja, com o cérebro externo ativo e o agente incluído desligado, o painel
    diz «Responde seu cérebro externo (Nea)» em vez de pedir a chave de IA.
