# E2E — Motor de agenda universal (015)

Roteiro de comportamento observável. Automatizado na seção `015` de
`scripts/e2e-selftest.mjs`: com a app no ar e os mocks ligados,
`pnpm test:e2e` o conduz e sai diferente de zero se algo falhar.

**Preparação**: app em `localhost` com `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock, `ZOOM_BASE_URL`/`ZOOM_OAUTH_BASE_URL` →
zoom-mock, `BOT_API_KEY` e a BD migrada. A bandeira `AGENDA` decide qual metade
do roteiro roda: as duas são exercitadas na matriz de CI.

---

## US1 — A instância decide se a agenda existe

Com `AGENDA` ausente:

1. `GET /api/calendar/settings`, `/api/calendar/availability` e `/api/bookings`
   respondem **404**.
2. `GET /api/bot/availability` responde **404** — antes mesmo de olhar a chave:
   o endpoint não existe aqui.
3. A tela `/bookings` responde 404 e a navegação não a menciona.

4. `GET /api/bot/context` **não** traz `booking` — nem vazio: um bloco vazio numa
   instância sem agenda seria lido como «este lead não tem consulta».

Com `AGENDA=on`, as mesmas rotas respondem normalmente, e o contexto traz
`booking` (sem consultas: `next`, `unresolved` e `lastClosed` em `null`).

## US2 — O negócio define quando atende

1. Uma instância recém-ligada devolve **padrões utilizáveis** (consulta de 30
   min, conector `enlace-fijo`) com 200, não um 404.
2. Salva-se um horário e uma sala fixa; a disponibilidade devolve vagas.
3. Cada vaga traz o **dia por extenso** além da hora — a etiqueta curta já
   agendou uma consulta no dia errado em produção.
4. Um fuso horário inventado é recusado com **422** em vez de salvo e de quebrar
   o motor depois.

## US3 — As duas garantias

1. **Só se reserva o que foi oferecido**: um instante livre e válido, mas nunca
   oferecido àquela conversa, é recusado com `409 slot_not_offered` e a resposta
   traz o que de fato foi oferecido.
2. **Caminho feliz**: reservar uma vaga oferecida responde **201 Created** (não
   200), com etiqueta e link; a vaga some da disponibilidade e a consulta aparece
   em Consultas marcada como agendada pela IA.
3. **A corrida**: uma segunda tentativa no mesmo instante responde `409` com o
   envelope **aninhado** e `slots` como **irmão**; no banco fica **uma única
   consulta ativa** naquele instante.
4. As alternativas do `409` já são a oferta vigente: reservar uma delas responde
   201 de imediato.
5. **Remarcar** pela superfície do bot responde **200**, não 201.
6. **O contexto do cérebro sabe da consulta**: depois de reservar,
   `GET /api/bot/context` traz `booking.next` com o id DESTA consulta, seu
   `startUtc`/`endUtc`, `status: "agendada"`, a etiqueta com o dia por extenso no
   fuso do negócio (`booking.timezone`) e o link que foi dado ao cliente. Depois
   de remarcar, a mesma consulta no instante novo. Sem isso, um cérebro só
   conhece a consulta pelo histórico: marca uma segunda para quem não chegou à
   primeira, ou dá por vigente uma que já passou.

## US3b — Um dia específico (vagas por data)

Um lead próprio, no final da seção 015 do arnês, que pergunta «tem algo amanhã à
tarde?». Na prova de ponta a ponta raiz + Nea, sem isso o cérebro só via as
três primeiras horas da manhã e respondeu que só havia manhã.

1. **Sem `date`, a forma de sempre**: `slots` (com `startUtc`, `endUtc`,
   `label`, `dayIso`, `dayLabel`, `time`) e `diasConAgenda`, mais `query` com
   `date: null`, `perDay: 3`, `coveredUntil` e `horizonEnd`.
2. **Com `date` = amanhã**: 200 com `query.date` = esse dia e
   `query.status: "available"`; só horas desse dia, além das três do
   revezamento, e alguma da tarde.
3. Um dia além do horizonte responde `beyond_horizon` sem horas, e uma data
   inexistente (`2026-02-31`) **422 `invalid_body`** — nenhuma das duas apaga a
   oferta vigente.
4. **Reservar** uma hora da tarde oferecida por data responde **201**, com essa
   hora na etiqueta, e deixa de ser oferecida naquele dia.

## US4 — O operador

1. Cancelar duas vezes não falha (idempotente). Cancelada pelo painel, o contexto
   do cérebro já **não** a dá por vigente (`booking.next`) e a traz em
   `booking.lastClosed` com `status: "cancelada"`, `cancelledBy: "equipo"` e sem
   link: assim o cérebro diz «foi cancelada» em vez de inventar um motivo.
2. Repetir o link de uma consulta que já o tem responde 422.
3. **O provedor fora do ar não custa a conversão**: com o conector externo sem
   credenciais, reservar responde **201 mesmo assim**, com `linkPending: true` e
   `meetingLink: null`, e a consulta aparece como "sem link" em Consultas.

## US5 — Conector Zoom

1. Credenciais que o provedor recusa respondem 422 e **não são salvas**: a
   conexão continua sem existir.
2. Válidas são salvas e, para o navegador, só saem os **últimos 4** caracteres —
   o segredo não aparece na resposta.
3. Agendar cria a reunião: o provedor a recebe com seu tema e sua hora, e o link
   volta na resposta.
4. Cancelar a consulta **apaga** a reunião no provedor.

## US6 — Conector Google

Coberto pela suíte de contrato (`tests/unit/connectors.test.ts`), que fixa o que
o seu mock reproduz: o link do Meet **não** vem na resposta de criar o evento —
a conferência é assíncrona —, o conector relê, e se ainda estiver pendente
entrega o evento sem link em vez de falhar. Tentar de novo relê esse mesmo
evento: **nunca** cria um duplicado na agenda do dono.

## Sandbox do Laboratório

1. Uma conversa de teste **pode** agendar (201) e a consulta fica marcada como
   de teste.
2. Com um conector externo ativo, o estado do mock fica **vazio**: o provedor
   jamais fica sabendo de uma consulta de teste. Verifica-se por ausência, e vale
   igual para criar, remarcar e cancelar.
