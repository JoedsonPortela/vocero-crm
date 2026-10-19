# Roteiro E2E — Guia de início: a primeira tela (#86)

> Automatizado em `scripts/e2e-selftest.mjs` (seção «guia de inicio»),
> contra `pnpm dev` com os mocks (`WA_MOCK_ENABLED=true`,
> `META_GRAPH_BASE_URL` → wa-mock, `OPENROUTER_BASE_URL` → ai-mock). Os passos
> de tela (ver a lista, apertar «Ligar») são conduzidos à mão ou com
> Playwright; o chicote verifica a decisão do servidor e a API.

O que se protege: que quem instala o Vocero veja PRIMEIRO o que falta para o
agente responder — e nada mais —, que cada passo se marque sozinho quando a peça
de fato funciona, e que o botão final ligue o agente. E que ninguém fique
preso: o guia captura só a raiz; o menu leva a qualquer tela.

## Primeiro login

1. Cadastrar-se (cria a organização) ou entrar como proprietário.
   ✅ `router.push("/")`: a raiz decide. `GET /` com a sessão → **307** para
   `/onboarding` enquanto faltar um passo ou o agente seguir desligado.
2. Abrir `/onboarding`.
   ✅ Cabeçalho «Deixe seu CRM pronto em N passos» (N = 3; 4 com `AGENDA=on`),
   barra de avanço «0 de N prontos», a lista numerada com o passo 1 destacado
   (`ring`) e, no fim, o cartão «No final: ligar o seu agente» explicando que ele
   começa desligado. No menu, acima de Bandeja: **Guia de início**.
3. `GET /api/onboarding/status` com a sessão.
   ✅ **200** `{steps, enabled:false, guide}`; `steps` traz `profile`, `ai`,
   `whatsapp` e `calendar` (`not_applicable` sem agenda, e aí `guide` não o
   inclui). Sem sessão → **401**; um membro da equipe → **403**.

## Os passos se marcam sozinhos

4. Passo 1 — `PUT /api/agent/profile {name, instructions}` (ou carregar
   conhecimento em Agente).
   ✅ `profile` passa a `ready`; na tela, check verde e «Pronto · revisar».
   Antes, com o nome de fábrica e sem instruções nem conhecimento, o passo dizia
   o que faltava («Dê um nome e escreva as instruções dele…»).
5. Passo 2 — Ajustes → IA: `PUT /api/settings/ai {provider, baseUrl, model,
   token}`.
   ✅ `ai` → `ready` com «Chave salva em Ajustes → IA». Se o ambiente traz
   `OPENROUTER_API_TOKEN`, o passo já estava pronto como «Reserva do ambiente»
   (a linha manda; o ambiente é reserva) e, ao apagar a linha
   (`DELETE /api/settings/ai`), volta a ele. Uma chave pausada por 401/402 aparece
   como pendente com a dica em âmbar («O provedor recusou a sua chave…»; unit:
   `onboarding-status.test.ts`).
6. Passo 3 — Ajustes → WhatsApp: `PUT /api/settings/whatsapp` com IDs de teste
   (wa-mock).
   ✅ `whatsapp` → `ready`. Depois de `DELETE /api/settings/whatsapp` volta a
   `pending`; com `reconnect_required` a dica diz que é preciso reconectar.
7. Passo 4 (só com `AGENDA=on`) — Ajustes → Agenda.
   ✅ Com `weeklyHours` vazio (todos os dias fechados) o passo fica `pending`; ao
   salvar seg-sex 09:00-18:00 com `enlace-fijo` passa a `ready` sem pedir
   credenciais de ninguém. Com Zoom/Google escolhido e sem credencial, a dica diz
   isso.

## Ligar

8. Com todos os passos prontos e o agente desligado.
   ✅ `guide.complete:true`, `enabled:false`; `GET /` continua mandando para
   `/onboarding`; o cartão final passa a «Tudo pronto! Ligue a <nome>» com o
   botão **Ligar**.
9. Apertar **Ligar** (`PUT /api/agent/profile {enabled:true}`).
   ✅ `enabled:true`; o cartão diz «<nome> já está respondendo» com «Ir para a
   Bandeja»; `GET /` → **307** para `/inbox`: o guia deixou de ser a primeira
   tela (segue no menu para revisá-lo).

## Caminho infeliz e guardas

10. Um membro da equipe (`role: member`) abre `/onboarding` → redireciona para
    `/inbox`; o seu `GET /` → `/inbox` sempre; no menu dele não há «Guia de
    início».
11. Um negócio demo recém-semeado («Carregar dados de demonstração»): a semente
    deixa o agente configurado (passo 1 pronto), mas não consegue vincular uma
    chave de IA nem um número → o guia segue sendo a primeira tela e diz isso; a
    Bandeja com a demo está a um clique no menu.
