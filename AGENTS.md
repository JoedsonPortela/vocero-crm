# AGENTS.md — Guia do Vocero CRM para agentes e pessoas

O Vocero é um CRM de WhatsApp open source (MIT) e self-hosted: caixa de entrada em
tempo real, funil kanban, agente de IA com o conhecimento do negócio e um
Laboratório onde clientes simulados avaliam o agente antes de falar com clientes reais.
Este guia serve igualmente para Claude Code, Codex, OpenCode ou uma pessoa: não depende
de skills, scripts ou plugins de nenhum assistente.

## Princípios invioláveis

- **Uma instância = um negócio.** Self-hosted; ainda assim, toda tabela de domínio leva `organization_id` e toda consulta passa por `scoped()`.
- **Somente WhatsApp Cloud API oficial.** Nada de Baileys nem sessões web. Todo tráfego para a Meta passa por `src/lib/meta/client.ts`.
- **Segredos cifrados em repouso** (AES-256-GCM, `src/lib/crypto/`); jamais para o cliente nem para logs. Os tokens de WhatsApp e do provedor de IA mostram apenas os últimos 4 caracteres.
- **O token do WhatsApp nunca sai do CRM.** Um bot externo conversa por `/api/bot/*`, não com a Meta.
- **Soberania.** O núcleo depende apenas de Postgres + WhatsApp Cloud API + um provedor LLM compatível com OpenRouter, opcional. Qualquer terceiro entra como conector opcional atrás de flag, desligado por padrão (`docs/adr-001-canais-opcionais.md`, `docs/adr-002-conectores-de-agenda.md`).
- **Português (Brasil)** em código, comentários, interface e documentação.
- A autoridade máxima é `.specify/memory/constitution.md`; em caso de conflito, vale a constituição.

## Stack

| Camada | O quê |
|---|---|
| Framework | Next.js 15 (App Router) + React 19, TypeScript estrito (`strict` + `noUncheckedIndexedAccess`), alias `@/` → `src/` |
| BD / ORM | PostgreSQL 16 + Drizzle ORM; migrações SQL versionadas em `drizzle/`, aplicadas ao iniciar o contêiner (`scripts/migrate.mjs`) |
| Auth | Better Auth + plugin de organização (`src/lib/auth/`); cadastro público fechado após a primeira organização |
| Validação | Zod em toda entrada externa (`parseBody` em `src/lib/api.ts`) |
| Tempo real | SSE em `GET /api/events` sobre um barramento in-process (`src/server/events/bus.ts`); sem WebSockets nem filas: o trabalho em segundo plano roda dentro do processo |
| UI | Tailwind CSS com tokens em `src/app/globals.css`, tema claro/escuro, white-label por organização |
| Testes | Vitest (`tests/unit/`) + roteiros E2E (`tests/e2e/*.md`) conduzidos por `scripts/e2e-*.mjs` (fetch e, alguns, Playwright) contra a app com mocks |
| Imagem | Docker multi-stage standalone, healthcheck `/api/health`, publicada em `ghcr.io/kevinrivm/vocero-crm:X.Y.Z` por `.github/workflows/imagen.yml` |

## Como executar

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d postgres   # Postgres local
pnpm init-env                                              # cria .env com os segredos gerados (DATABASE_URL aponta para `postgres`: troque para localhost no pnpm dev)
pnpm doctor                                                # valida o ambiente e testa a base
pnpm db:migrate                                            # aplica drizzle/ em desenvolvimento
pnpm dev                                                   # http://localhost:3000
```

| Comando | O que faz |
|---|---|
| `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` | Os quatro gates do CI (`pnpm test` é `vitest run`; `pnpm test:watch` para iterar) |
| `pnpm test:e2e` | `scripts/e2e-selftest.mjs` contra a app ativa com mocks. `test:e2e:calendario` e `test:e2e:resultados` conduzem seus roteiros; os demais `scripts/e2e-*.mjs` rodam com `node --env-file=.env scripts/<nome>.mjs` |
| `pnpm db:generate` | Gera uma migração nova em `drizzle/` a partir de `src/lib/db/schema.ts` |
| `pnpm seed:demo` | Carrega a Ferretería El Martillo (também pela interface, no primeiro acesso) |
| `pnpm init-env [--domain x]` | Cria `.env` a partir de `.env.example` com os segredos gerados e `DOMAIN=localhost` (ou o domínio informado); nunca sobrescreve um existente. Lógica em `src/server/doctor/init-env.ts` |
| `pnpm doctor` | Uma linha ✓/✗ por verificação, com a correção exata: variáveis (mesmo esquema zod de `src/lib/env.ts`), `select 1` em `DATABASE_URL`, escrita em `MEDIA_DIR` e, se houver número conectado, o token na Meta. Sai com 1 se algo obrigatório falhar. Lógica em `src/server/doctor/checks.ts` |

Variáveis obrigatórias (`src/lib/env.ts` as valida no primeiro uso; cada uma traz seu comando `openssl` em `.env.example`):

| Variável | Para quê |
|---|---|
| `APP_BASE_URL` | URL pública; dela sai a URL do webhook |
| `DATABASE_URL` | Postgres. A conexão fixa `TimeZone=UTC`: é o invariante de tempo do projeto |
| `BETTER_AUTH_SECRET` | Assinatura das sessões (mínimo de 16 caracteres) |
| `ENCRYPTION_KEY` | Exatamente 32 bytes em base64: cifra o token do WhatsApp |
| `META_WEBHOOK_VERIFY_TOKEN` | Verify token e segmento secreto de `/api/webhooks/wa/<token>` |
| `META_GRAPH_API_VERSION` | Versão da Graph API (tem padrão `v25.0`; as cinco acima não têm) |

Opcionais com efeito grande: `META_APP_SECRET` (assinatura do webhook), `OPENROUTER_API_TOKEN` / `OPENROUTER_MODEL` (reserva do provedor de IA: o normal é Configurações → IA, que tem prioridade sobre elas; sem nenhuma das duas não há Agente nem Laboratório), `BOT_API_KEY` (abre `/api/bot/*`), `BRAIN_DISPATCH_URL` (com ela e `BOT_API_KEY`, o CRM envia cada turno a um cérebro externo e o agente incluído fica em silêncio), `ALLOW_SIGNUP`, `AGENT_COALESCE_MS`, `WA_MOCK_ENABLED` (apenas desenvolvimento).

Flags de implantação (desligadas por padrão; o código delas sempre está na `main` e a migração é aplicada do mesmo jeito):

| Flag | Liga |
|---|---|
| `AGENDA=on` | Motor de agendamentos: tela Agendamentos, Configurações → Agenda, `/api/bookings`, `/api/calendar/*`, `/api/bot/availability` e `/api/bot/bookings`, instruções de agendar no prompt do agente (`src/server/agenda/flag.ts`) |
| `CHANNELS=whatsapp,instagram,messenger,tiktok` | Canais extras: webhooks `/api/webhooks/ig`, `/api/webhooks/messenger` e `/api/webhooks/tiktok`, Configurações → Status, Instagram, Messenger e TikTok, credenciais por canal, distintivo na caixa de entrada (`src/server/channels/enabled.ts`) |
| `ATRIBUCION=on` | Gravação do `ctwa_clid`, envio para a Conversions API da Meta, Configurações → Anúncios e `/api/settings/capi` (`src/server/attribution/flag.ts`). O anúncio de origem aparece sempre, com ou sem a flag |

Desligada, cada superfície responde 404 (não 403). A implantação em produção está no README («Instalação»: Rotas A e B, e «Outras plataformas» com `render.yaml`, `fly.toml` e `railway.toml`) e em `INSTALL-IA.md`; não é repetida aqui.

## Mapa do código

### `src/server/` — lógica de domínio (nunca importada por componentes de cliente)

| Pasta | Responsabilidade | Entrada |
|---|---|---|
| `agenda/` | Motor de agendamentos: horários, vagas, ofertas, reservas e conectores (link fixo, Zoom, Google) | `service.ts`, `flag.ts`, `http.ts`, `connectors/index.ts` |
| `ai/` | Turno do agente incluído: coalesce + lock por conversa (com a conta de quais entradas o próximo turno deve, 025), prompt, ação tipada, handoff. `trigger.ts` decide após cada entrada: despacho ao cérebro se estiver ativo, e senão o agente incluído; nunca os dois. Credencial do provedor de IA por organização (cifrada; estado `active` ou pausada por 401/402), o que valida e devolve Configurações → IA, e o aviso de «agente sem IA» | `pipeline.ts`, `orden-turno.ts`, `prompts.ts`, `actions.ts`, `credentials.ts`, `settings.ts`, `aviso.ts` |
| `analytics/` | Números de Resultados (vendas, agente, anúncios, higiene) agregados em SQL; exclui o Laboratório | `sales.ts`, `bot.ts`, `ads.ts`, `hygiene.ts`, `shared.ts` |
| `attribution/` | De qual anúncio veio cada conversa e envio à CAPI após `ATRIBUCION` | `referral.ts`, `store.ts`, `conversions.ts`, `flag.ts` |
| `auth/` | Cadastro fechado após a primeira organização; criação do primeiro dono com funil e perfil semeados | `registration.ts`, `on-signup.ts` |
| `bot/` | API de serviço para um cérebro externo: autenticação por `X-API-Key`, perfil, ficha, handoff, «quem responde» | `auth.ts`, `status.ts`, `profile.ts` |
| `brains/` | 021 — O despacho ao cérebro: formato do evento e assinatura (pura; a ordem das chaves é contrato), se há despacho configurado, e o POST assinado. 026 — o evento `conversation.deleted` (`construirEventoOlvido`, `avisarOlvido`: uma tentativa, fora do outbox) | `contract.ts`, `config.ts`, `deliver.ts` |
| `channels/` | Quais canais estão ligados e o que cada um pode fazer (duração da janela, modelos, tamanho em bytes ou caracteres, teto de mensagens desde a última entrada). 023 — o estado de cada canal para Configurações → Status | `enabled.ts`, `capabilities.ts`, `status.ts` |
| `dispatch/` | 021 — Outbox do despacho no Postgres: um despacho vivo por conversa (índice único parcial), lease, três tentativas, queda para humano; o worker em processo e o que o cartão mostra. 025 — cada despacho anota quais entradas deve (`message_ids`) | `outbox.ts`, `worker.ts`, `encolar.ts`, `estado.ts` |
| `dev/` | Estado em memória dos mocks (wa, ai, zernio, zoom, google); só com mocks ativos | `wa-mock-state.ts`, `ai-mock.ts` |
| `events/` | Barramento in-process por organização que alimenta o SSE; publicar sempre após o commit | `bus.ts` |
| `contacts-import.ts` (arquivo) | 027 — Importação de contatos em lote (reexecutável, sem criar conversa nem lead) e levar a pausa do contato para a conversa. A parte pura (ler o CSV, normalizar telefones) fica em `src/lib/contact-import.ts` e é usada pelo diálogo e pela rota | `src/server/contacts-import.ts` |
| `inbox/` | Ingestão idempotente, identidade do contato, envio com guardas, janela de atendimento (a duração é do canal), teto de mensagens do canal, estados monotônicos. 026 — excluir uma conversa (fio ou contato): o que as cascatas não fazem (anexos, ficha, agendamento futuro) | `ingest.ts`, `send.ts`, `identity.ts`, `webhook.ts`, `window.ts`, `outbound-cap.ts`, `eliminar.ts` |
| `instagram/` | Adaptador do canal Instagram (Meta ou Zernio), atrás de `CHANNELS` | `ingest.ts`, `send.ts`, `credentials.ts` |
| `lab/` | Laboratório: execução em segundo plano com personas roteirizadas e juiz LLM; conversas `is_test` | `runner.ts`, `personas.ts`, `judge.ts` |
| `leads/` | Única porta que escreve `lead.stage_id` (com histórico) e a prioridade do lead | `stage-history.ts`, `priority.ts` |
| `messenger/` | Adaptador do canal Messenger (Meta ou Zernio), atrás de `CHANNELS` | `ingest.ts`, `send.ts`, `credentials.ts` |
| `tiktok/` | 022 — Adaptador do canal TikTok (somente Zernio), atrás de `CHANNELS` | `ingest.ts`, `send.ts`, `credentials.ts` |
| `onboarding/` | Guia de início: o que falta para o agente responder (perfil, IA, WhatsApp e, com `AGENDA`, agenda), os passos que o dono vê e se a guia é a primeira tela (`guideFirst`) | `status.ts`, `guide.ts`, `calendar-verifiers.ts` |
| `seed/` | Negócio demo idempotente «Ferretería El Martillo» | `demo.ts` |
| `whatsapp/` | Credenciais cifradas, teste de conexão e inscrição do webhook, mídia, modelos | `credentials.ts`, `connect.ts`, `media.ts`, `templates.ts` |
| `zernio/` | Transporte e assinatura da API unificada do Zernio; distribui cada evento ao canal certo. 023 — resolve a conta contra `GET /accounts` ao salvar, cadastra o webhook limitado às contas da organização e verifica a assinatura contra os segredos salvos e os que o Zernio tem para esta instância. 030 — o segredo de assinatura é salvo cifrado, como o token; a inicialização cifra o que uma versão anterior deixou em claro | `index.ts`, `dispatch.ts`, `cuentas.ts`, `webhooks.ts`, `conexiones.ts`, `guardar.ts`, `secreto-guardado.ts` |

Avulsos: `contacts.ts` (serialização), `contact-source.ts` (origem do lead), `branding.ts` (marca salva na organização), `health.ts` (o que `/api/health` responde: BD, versão, flags ativas, `mediaWritable`), `media-dir.ts` (teste de escrita de `MEDIA_DIR`, em cache por 60 s; é compartilhado pela inicialização e pelo health).

### O restante

| Caminho | O que há |
|---|---|
| `src/lib/` | Fronteiras e utilitários sem estado: `env.ts` (validação lazy), `db/` (`schema.ts`, `tenant.ts` com `scoped()`, `ids.ts` com prefixos `ct_`, `cv_`, `msg_`…), `auth/` (sessão e `roles.ts`: quem configura), `crypto/`, `meta/` (`client.ts` Graph API, `capi.ts`, `destinatario.ts`, `send-errors.ts`), `ai/` (adaptador LLM com `chatJson<T>`; `provider.ts` decide com quem falar — a linha de Configurações → IA e, de reserva, `OPENROUTER_*` —, `probe.ts` testa a conexão e lista modelos, `presets.ts` o catálogo), `api.ts` (`withAuth`, `parseBody`, `apiError`), `rate-limit.ts`, `dev-guard.ts`, `version.ts`, catálogos compartilhados com a UI (`channels.ts`, `agenda-connectors.ts`, `analytics.ts`, `types.ts`, `nav.ts`: grupos do menu e seções de Configurações conforme flags e papel), marca e tema (`brand.ts`, `branding.ts`, `theme.ts`, `favicon.ts`), tempo e dinheiro (`time/`, `money.ts`) |
| `src/components/` | React: primitivos em `ui/` (incluindo `empty-state.tsx`, o estado vazio comum); uma pasta por tela (`inbox/`, `pipeline/`, `contacts/`, `agent/`, `lab/`, `results/`, `bookings/`, `onboarding/`, `settings/`); `app-shell.tsx`, `app-nav.tsx`, `use-events.ts` (cliente SSE), `use-theme.ts` |
| `src/app/(app)/` | Telas autenticadas: `onboarding` (guia de início: primeira tela enquanto falta um passo ou o agente segue desligado; `src/app/page.tsx` decide), `inbox`, `pipeline`, `contacts`, `results`, `agent`, `lab`, `bookings` (AGENDA) e `settings/{whatsapp,branding,templates,team,ai,calendar,ads,messenger,tiktok}`. Em `(auth)/`: `login` e `register` |
| `src/app/api/` | Route handlers: `auth/[...all]` (Better Auth) · `conversations`, `contacts`, `pipeline`, `kb`, `agent`, `lab`, `templates`, `analytics`, `bookings`, `calendar`, `media`, `branding`, `seed`, `onboarding/status` (sessão + organização) · `settings/*` (WhatsApp, webhook, marca, equipe, IA —`ai`, com `ai/test` e `ai/models`—, capi, zoom, google, instagram, messenger, tiktok) · `bot/*` (X-API-Key) · `webhooks/{wa,ig,messenger,tiktok}/[webhookToken]` (públicos) · `events` (SSE) · `health` · `dev/*` (mocks, 404 em produção) |
| `tests/` | `unit/*.test.ts` (Vitest sem banco de dados: módulos puros, guardrails que varrem `src/`, contratos) e `e2e/*.md` (roteiros por história com critérios de aceitação) |
| `scripts/` | `e2e-*.mjs` (chicotes dos roteiros), `migrate.mjs` (migrador do contêiner), `seed/demo.ts`, `reset-password.mjs` (imprime o `UPDATE`, não toca a BD), `screenshots.mjs` |
| `drizzle/` | `0000…0020_*.sql` + `meta/` (snapshots e `_journal.json`). É gerado, nunca editado à mão. Na imagem vão apenas os `.sql` e `_journal.json`: o migrador não abre os snapshots (`.dockerignore`) |
| `specs/` | Specs por funcionalidade (001, 002, 003, 014–030) com seus contratos; `specs/README.md` explica o que há e o que não há |
| `docs/` | ADR-001/002, `agenda-conectores.md`, `atribucion-capi.md`, capturas do README. (`getting-started.md`, `sdd-workflow.md`, `three-agent-architecture.md` e `mcp-setup.md` descrevem o starter do Claude Code, não o Vocero) |

## Fluxo de uma requisição: uma mensagem do WhatsApp

1. A Meta faz `POST /api/webhooks/wa/<token>` → `src/app/api/webhooks/wa/[webhookToken]/route.ts`: o segmento deve igualar `META_WEBHOOK_VERIFY_TOKEN` (senão, 404) e a assinatura HMAC só é validada se houver `META_APP_SECRET` (`src/server/inbox/webhook.ts`). Responde 200 imediatamente e processa em `after()`.
2. `processMessagesValue` em `src/server/inbox/ingest.ts`: credenciais por `phone_number_id` (`whatsapp/credentials.ts`), identidade do remetente (`inbox/identity.ts` → contato por `wa_identity`), deduplicação por `wa_message_id`, anexos (`whatsapp/media.ts`), anúncio de origem (`attribution/referral.ts` + `store.ts`), lead na primeira etapa (`inbox/lead-activity.ts`) e `publish("message.new")`.
3. `src/server/ai/trigger.ts` → `scheduleAgentTurn` em `ai/pipeline.ts`: espera `AGENT_COALESCE_MS`, um turno por conversa, monta o prompt (`ai/prompts.ts`), chama `chatJson` (`src/lib/ai/index.ts`, com o provedor de Configurações → IA ou, de reserva, `OPENROUTER_*`; um 401/402 do provedor pausa a credencial), valida a ação com Zod (`ai/actions.ts`) e a executa: responder, mover de etapa (`leads/stage-history.ts`), escalar, oferecer ou reservar agendamento (`agenda/agent.ts`).
4. `src/server/inbox/send.ts`: recusa conversas `is_test` (`sandbox_violation`) e janela fechada (`window_closed`, `inbox/window.ts`), consulta o canal (`channels/capabilities.ts`), chama `graphRequest` (`src/lib/meta/client.ts`), persiste a mensagem e publica.
5. Os `statuses` do webhook passam por `inbox/status.ts` (nunca regridem) e saem como `message.status`.
6. `GET /api/events` (`src/app/api/events/route.ts`) emite os eventos da organização; `src/components/use-events.ts` os recebe e a caixa de entrada faz catch-up com `since=`.

Com `BRAIN_DISPATCH_URL` e `BOT_API_KEY`, o passo 3 não pensa: `ai/trigger.ts` enfileira um despacho (`dispatch/encolar.ts`), o worker espera a mesma janela `AGENT_COALESCE_MS`, monta o evento com a rajada (`brains/deliver.ts`) e o entrega assinado ao cérebro, que responde com `POST /api/bot/messages` e entra no passo 4. A rajada é o posterior à última saída mais o que o despacho anotou como devido (`dispatch.message_ids`): o que o cliente escreveu enquanto o cérebro pensava viaja mesmo que já haja uma resposta depois (025). Vale igualmente para Instagram, Messenger e TikTok: todos passam por `ingestInboundMessage`. Sem essa variável, um cérebro externo também pode receber o webhook por conta própria e conversar por `/api/bot/*` com o agente incluído desligado.

## Invariantes ao modificar

- **Identidade do contato**: a chave estável é `contact.wa_identity` (telefone normalizado 521→52, `bsuid:<id>`, `ig:<id>`, `fb:<id>`, `tt:<id>`); `phone` é opcional. Nunca presuma que um contato tem telefone.
- **Escopo de organização**: `organization_id` NOT NULL em toda tabela de domínio e toda consulta construída com `scoped()` de `src/lib/db/tenant.ts`.
- **Zod em toda entrada externa** (body, query, webhooks, respostas do LLM). Um 422 traz o detalhe; a saída do modelo é extraída com tolerância e novas tentativas: um soluço do provedor nunca derruba o turno.
- **Migrações aditivas**: altere `src/lib/db/schema.ts`, rode `pnpm db:generate`, revise o SQL e envie junto com a mudança. São aplicadas ao iniciar o contêiner; uma instalação antiga precisa atualizar sem passos manuais (caso contrário, é versão maior).
- **Sandbox e janela**: uma conversa `is_test` jamais toca a API real (o sender lança exceção; é um guardrail, não um bug) e o texto livre só sai dentro da janela do canal após a última entrada: 24 h no WhatsApp, Instagram e Messenger, 48 h no TikTok. Nunca escreva «24 h» no núcleo: pergunte a `windowMsFor(channel)` (`src/server/channels/capabilities.ts`). 024 — Instagram e Messenger declaram ainda uma janela humana (`humanAgentWindowMs`, 7 dias): quem pode escrever e com qual etiqueta decide `replyWindow` (`src/server/inbox/window.ts`), e `assertReplyWindow` aplica isso na verificação prévia do envio; a IA nunca usa a etiqueta de agente humano. O texto gerado pela IA sai sem formatação nos canais com `textFormat: "plain"` (`src/lib/social-text.ts`, aplicado em `sendText`).
- **Os limites de um canal se declaram, não se codificam** (022): janela, forma de reabri-la, tamanho do texto e teto de mensagens vivem em `CHANNEL_CAPABILITIES`. O envio consulta esses dados e falha antes de chamar a plataforma, com um `SendError` próprio (`window_closed`, `message_limit`, `text_too_long`). Igual na agenda: um agendamento de teste nunca chega a um conector.
- **Uma só porta por invariante**: `lead.stage_id` só é escrito em `src/server/leads/stage-history.ts` (um teste varre `src/`); o tráfego para a Meta só passa por `src/lib/meta/client.ts`; o LLM só por `src/lib/ai/`.
- **Idempotência**: deduplicação por `wa_message_id` UNIQUE, estados monotônicos, seeds e migrações reexecutáveis.
- **Mocks** (`src/app/api/dev/*`) só com `WA_MOCK_ENABLED=true` e fora de produção (`src/lib/dev-guard.ts`); jamais como reserva em tempo de execução.
- **`/api/bot/*` e o evento de despacho são contrato público**: não altere formatos nem códigos sem versionar. Acrescentar uma chave cabe; remover ou renomear, não. O evento só é montado em `armarEvento` (`src/server/brains/contract.ts`): a assinatura é feita sobre o JSON exatamente como sai, e `tests/unit/despacho-contrato.test.ts` fixa um corpo e sua assinatura byte a byte.
- **Caixa de entrada primeiro, cérebro depois**: um despacho só é enfileirado quando a mensagem já está salva. Uma falha posterior não perde a mensagem; deixa a conversa com uma pessoa.
- **«Sem responder» não é «sem entregar»** (025): quem conduz o turno anota o id da entrada que o provoca — o despacho em `dispatch.message_ids`, o agente incluído na sua entrada de coalesce — e deve isso até o cérebro recebê-la ou uma pessoa responder. Uma saída do agente não quita uma mensagem que ele não leu; uma de uma pessoa (`ai_generated = false`) quita. Um despacho sem mensagens é descartado, nunca entregue.
- **Módulos opcionais** ficam atrás de flag, desligados por padrão, com superfície em 404 e migração aplicada do mesmo jeito. Nunca em um branch separado.
- **UI com tokens**: cores por variáveis de `globals.css` mapeadas em `tailwind.config.ts` (`bg-background`, `text-foreground`, `bg-primary`, `text-muted-foreground`…); nada de `text-white` nem hex soltos, salvo cores de marca de terceiros. `tests/unit/contraste-temas.test.ts` mede os tokens reais nos dois temas. White-label: nenhum «Vocero» fixo na interface.
- **`route.ts` exporta apenas handlers** (`GET`, `POST`… e `dynamic`): a lógica fica em `src/server/` para poder ser testada; o Next rejeita outros exports na build.
- **Segredos de canal em repouso** (030): o segredo de assinatura do Zernio para Instagram, Messenger e TikTok só é gravado com `columnasDelSecreto` e lido com `secretoDeLaFila` (`src/server/zernio/secreto-guardado.ts`); a coluna `webhook_secret` está obsoleta, nada a escreve e será removida em uma versão maior. Um segredo novo em qualquer tabela vai em colunas `*_cipher`, `*_iv`, `*_tag` com `src/lib/crypto`, nunca em texto puro.
- **Credenciais novas**: placeholder `REEMPLAZA_...` em `.env.example` com guia inline; em produção ficam na plataforma (runtime, não build).

## Contratos públicos

**`/api/bot/*`** — cabeçalho `X-API-Key` igual a `BOT_API_KEY` (mínimo de 16 caracteres; sem ela tudo responde 401). 1200 chamadas por minuto autenticadas; 30 falhas por minuto por IP e depois 429. Os 409 vêm tipados: `ai_paused`, `window_closed`, `sandbox_violation`, `message_limit` (022: o canal não aceita mais mensagens até o cliente escrever). Respeita `conversation.ai_enabled` e `handoff_at` do mesmo modo que o agente incluído.

| Endpoint | Para quê |
|---|---|
| `GET /api/bot/context?waIdentity=…` | Contato, etapa, ficha, handoff, janela de 24 h e (com AGENDA) agendamentos |
| `POST /api/bot/messages` | Responder; sai por `inbox/send.ts` marcado como IA |
| `GET /api/bot/profile` | Perfil do agente e base de conhecimento |
| `PUT /api/bot/ficha` | Salvar o que o bot descobre do lead (chaves livres) |
| `POST /api/bot/handoff` | Devolver a conversa a um humano |
| `POST /api/bot/typing` | Marcar como lida e «digitando…» |
| `GET /api/bot/media/{mediaId}` | Baixar um anexo recebido sem tocar a Meta |
| `POST /api/bot/reset` | Reiniciar uma conversa de testes |
| `GET /api/bot/availability` | Com AGENDA: horários para oferecer (ficam registrados como oferecidos) |
| `POST` · `PATCH /api/bot/bookings` | Com AGENDA: reservar (201) ou remarcar (200) apenas um horário oferecido |

Documentação: README («Traga o seu próprio agente»), roteiro `tests/e2e/us-bot-api.md`, testes `tests/unit/bot-*.test.ts` e, para a agenda, `specs/015-motor-agenda-universal/contracts/agenda.md`.

**Despacho (CRM → cérebro)** — com `BRAIN_DISPATCH_URL`, um `POST` assinado (`X-Vocero-Signature: sha256=<HMAC-SHA256 do corpo cru com BOT_API_KEY>`, `X-Vocero-Dispatch-Id`, `X-Vocero-Organization`) com a rajada da conversa: `dispatchId`, `organization`, `conversation` (`channel`, janela), `contact` (`identity`) e `messages`. 2xx = recebido; 429 e 5xx são repetidos (três tentativas); outro 4xx não, e a conversa passa para um humano (`handoff_reason = error`). `messages` nunca vai vazio, e uma mensagem pode ser anterior à última resposta do cérebro (025). Contrato em `specs/021-despacho-estandar/contracts/despacho.md`, roteiro `tests/e2e/us-despacho.md`, chicote `scripts/e2e-despacho.mjs`.

**Webhooks de entrada** — `GET`/`POST /api/webhooks/wa/[token]` (contrato em `specs/001-vocero-core/contracts/webhook.md`); `/api/webhooks/ig/[token]` e `/api/webhooks/messenger/[token]` aceitam Meta ou Zernio pela mesma URL e existem apenas com o canal em `CHANNELS` (specs 014 e 017); `/api/webhooks/tiktok/[token]` aceita somente Zernio (spec 022). Um evento do Zernio é distribuído por plataforma, chegue por qualquer um dos três, e sua assinatura é verificada em `isAuthenticZernioDelivery` (`src/server/zernio/dispatch.ts`): vale qualquer segredo do Zernio da organização, ou o do webhook que o Zernio tem apontando para esta instância. Sempre 200 após validar; o processamento é assíncrono.

**`GET /api/health`** — `{"ok":true,"version":"X.Y.Z","commit":"…","commitVerified":true|false,"features":{"agenda":bool,"channels":["whatsapp",…],"atribucion":bool},"mediaWritable":bool}`; 503 `db_unavailable` sem base. `features` sai das mesmas flags que decidem os 404 (`AGENDA`, `CHANNELS`, `ATRIBUCION`); `mediaWritable: false` não derruba `ok` nem o código. **`GET /api/events`** — SSE autenticado por sessão (`specs/001-vocero-core/contracts/sse.md`). A API interna (`specs/001-vocero-core/contracts/api.md`) não é contrato público: quem a consome é somente a interface deste repositório.

## Como contribuir

1. Branch a partir de `main` (`feat/…`, `fix/…`, `docs/…`, `chore/…`) e PR para `main`. O autor do projeto faz os merges.
2. Antes de abrir o PR: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. O CI (`.github/workflows/ci.yml`) roda esses quatro gates em duas configurações, flags desligadas e `CHANNELS` + `AGENDA` ligadas; `imagen.yml` constrói a imagem Docker em cada PR.
3. Comportamento observável novo: amplie ou escreva o roteiro em `tests/e2e/` e, se possível, o chicote em `scripts/e2e-*.mjs`; rode-o contra a app com mocks (`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → `/api/dev/wa-mock/graph`, `OPENROUTER_BASE_URL` → `/api/dev/ai-mock`, `BOT_API_KEY`; receita em `specs/001-vocero-core/quickstart.md`). Teste também o caminho de falha.
4. Specs (`specs/`): se você mexer no modelo de dados ou em um contrato publicado, ciclo completo em `specs/NNN-nome/`; comportamento novo sem isso, um `spec.md` leve; correções, refatorações e dependências ficam isentas (Princípio VI da constituição).
5. Versão e release: suba `version` em `package.json`, o padrão de `VOCERO_CRM_VERSION` em `docker-compose.yml` (`tests/unit/version.test.ts` exige que coincidam) e a tag da imagem em `render.yaml`, `fly.toml` e `railway.toml` (`tests/unit/manifests-plataformas.test.ts`), adicione a entrada em `CHANGELOG.md` com seu «Atualizar a partir de…» e atualize a tag da imagem em `INSTALL-IA.md`. A tag `vX.Y.Z` publica a imagem.
6. Dependências: `pnpm install --frozen-lockfile` deve passar; um terceiro novo no núcleo precisa de justificativa constitucional (Princípio II).

As instruções específicas do Claude Code estão em `CLAUDE.md`.
