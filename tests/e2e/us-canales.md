# E2E — Configurações → Canais e correções do Zernio (023)

Chicote: `scripts/e2e-canales.mjs`. Spec:
[`specs/023-ajustes-canales/spec.md`](../../specs/023-ajustes-canales/spec.md).

Pré-condição: app rodando (`next dev`) sobre uma base migrada, com
`CHANNELS=whatsapp,instagram,messenger,tiktok`, `WA_MOCK_ENABLED=true` e
`ZERNIO_BASE_URL` → zernio-mock. Não é preciso o agente.

O chicote faz de **proprietário** (salva as conexões pelas mesmas rotas que as
telas usam) e de **Zernio**: diz ao simulador quais contas e quais webhooks a
chave tem (`POST /api/dev/zernio-mock/_accounts`, `_webhooks`), derruba-o
(`_down`), entrega eventos assinados e lê o que o CRM deixou nele (`GET
/api/dev/zernio-mock/_state`).

```bash
node --env-file=.env scripts/e2e-canales.mjs
```

## D1 — A conta é resolvida contra a chave

1. Chave que o Zernio recusa → 422 `invalid_token`.
2. Sem `accountRef` e com uma única conta de Instagram → 200 com essa conta; a
   conexão guarda o seu usuário e o id de Instagram que o Zernio devolve.
3. Com o id do **perfil** → salva-se o id da conta.
4. Com a conta do Facebook, ou com um id que não existe → 422 `unknown_account`
   que diz qual serve; a conexão boa continua intacta.
5. Com duas contas de Instagram na chave → 422 `choose_account` com as duas em
   `error.details.accounts`; escolhendo uma → 200.
6. Com o Zernio fora do ar → 503 `platform_unavailable`, não «chave inválida».
7. Com um app próprio da Meta o ID da conta continua obrigatório.

## D7 — Só o proprietário conecta

8. Uma pessoa da equipe recebe 403 ao salvar Instagram, Messenger ou TikTok e ao
   reparar o webhook. Ela pode ver o estado (`canManage: false`).

## D4 — O webhook se cadastra sozinho

9. Ao conectar Instagram, o Zernio fica com **um** webhook para esta instância:
   ativo, com `message.received`, limitado às contas conectadas e com um segredo
   gerado. A resposta não traz chave nem segredo.
10. Ao conectar Messenger (sem `accountRef`: pega-se a página, com seu nome e seu
    id) é o **mesmo** webhook, com as duas contas e o mesmo segredo.
11. TikTok pessoal se conecta, mas a resposta avisa que não receberá mensagens
    até ser Business. O webhook fica com as três contas.
12. Um webhook alheio dessa chave (outra URL) continua exatamente igual.
13. Se o Zernio falhar ao registrar, a conexão é salva e a falha é dita
    (`webhook.ok: false`, `zernio_unavailable`).

## D3 — A assinatura

14. Instagram bem assinado → 200 e entra na bandeja. Assinatura quebrada ou
    ausente → 401.
15. Messenger assinado com o mesmo segredo, pela URL do Instagram → 200 e entra
    como Messenger.
16. O segredo muda no Zernio sem o CRM saber → a entrega assinada com o novo é
    aceita (lê-se do Zernio com a chave salva).
17. Nem as entregas boas nem as assinaturas inválidas voltam a perguntar ao
    Zernio dentro do minuto (cache). Um segredo de ninguém → 401. O salvamento
    continua valendo.
18. Com o Zernio fora do ar: um segredo que o CRM não conhece → 401; o
    salvamento → 200.
19. Um evento de uma conta que ninguém conectou aqui → 200 e não é ingerido.

## D2 — Autocura

20. Uma conexão de Messenger salva com o id do perfil: um evento sem assinatura
    válida não a corrige (401); o mesmo evento bem assinado entra na bandeja e
    deixa a conexão com o id da conta.

## D5 — Estado

21. `GET /api/settings/channels`: uma linha por canal ligado, WhatsApp primeiro.
    Instagram com a sua conta, sua última mensagem e conta e webhook sãos.
    Messenger com a conta que o Zernio marca para reconectar, em erro. TikTok
    pessoal, em erro e dizendo por quê. Sem chave, segredo nem segmento do webhook
    na resposta.
22. Webhook desativado → erro nos três; «reparar» o reativa sem criar outro.
    Webhook sem uma conta → erro nessa. Falhas de entrega → aviso com a hora do
    último disparo. Sem webhook → erro; «reparar» o cria com as três contas e o
    segredo que o CRM já tinha.
23. Com o Zernio fora do ar a tela carrega e diz isso, sem inventar um «tudo bem».
24. TikTok já Business: ao reconectar deixa de avisar e os três ficam sãos.

## 030 — O segredo em repouso

25. No fim, no banco: nenhuma linha de `instagram_credentials`,
    `messenger_credentials` ou `tiktok_credentials` tem `webhook_secret`; as do
    Zernio têm `webhook_secret_{cipher,iv,tag}`, e nenhuma linha contém o segredo
    do webhook como texto.

## Interface (à mão, claro e escuro)

- **Configurações → Estado**: o distintivo de cada canal diz o pior que lhe
  acontece («Com problemas», «Revisar»), não «Conectado» em cima de um erro.
- **Configurações → Instagram**: colar a chave e «Testar e conectar». Com várias
  contas, escolher uma nos botões. Ao terminar diz qual conta ficou e o que
  aconteceu com o webhook.
- No celular a tela de estado não estoura a largura.
