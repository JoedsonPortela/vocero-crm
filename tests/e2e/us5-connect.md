# Roteiro E2E — US5: Conexão do número (assistente)

> Conduzido com Playwright (MCP) contra `pnpm dev` com wa-mock
> (`META_GRAPH_BASE_URL` → wa-mock/graph).

## Caminho feliz

1. Abrir `/settings/whatsapp`.
   ✅ O assistente explica as DUAS origens do token (modo direto / modo agência
   Tech Provider).
2. Preencher WABA ID + Phone Number ID + token (sem o sufixo `-invalid`) →
   "Testar conexão".
   ✅ "Token válido para +52 …". O botão Salvar só se habilita DEPOIS do teste.
3. Salvar.
   ✅ Estado "Conectado" com número de exibição e token …last4; o token ficou
   cifrado no banco (unit test) e, como a WABA não tinha override, o app foi
   inscrito com `subscribed_apps` e o webhook da instância foi registrado no
   NÚMERO (override do número, com o handshake da Meta). Embaixo do formulário:
   «Webhook registrado na Meta…». Automatizado em `scripts/e2e-selftest.mjs`
   (seção "us5"), que lê o registrado em `GET /api/dev/wa-mock/webhooks`.
4. Seção Webhook:
   ✅ URL COMPLETA com o verify token como segmento + botão copiar (apoio manual);
   botão «Registrar na Meta» que repete o registro com a conexão salva, sem colar
   o token de novo; aviso informativo (não erro) se META_APP_SECRET não estiver
   configurado; nota de segurança sobre o token na URL.
4b. «Desconectar» no cartão do número conectado → confirmação («Você deixará de
   receber e enviar. Suas conversas ficam.») → Sim, desconectar.
   ✅ A conexão desaparece, o override do número é removido na Meta
   (`phoneWebhooks` do mock sem o número) e a bandeja segue intacta.

## Caminhos infelizes

5. Token com sufixo `-invalid` → "Testar conexão".
   ✅ Erro claro de token inválido; NÃO é salvo (a conexão anterior fica intacta).
6. Handshake GET do webhook com verify token correto → challenge; segmento
   incorreto → 404 (coberto também no roteiro de US1).
7. A WABA já roteia para um override (cérebro externo como a Nea, ou o backend de
   uma agência) → girar o token e Salvar.
   ✅ Salva do mesmo jeito, e o override CONTINUA em `GET {WABA}/subscribed_apps`:
   o CRM consulta antes e não reinscreve, porque na Meta um POST sem corpo apaga o
   override. Também não registra o webhook do número — esse vence o da WABA e
   deixaria o cérebro externo surdo —: se um salvamento anterior o tinha deixado,
   remove-o, e o aviso diz a qual host se respeita. Automatizado em
   `scripts/e2e-selftest.mjs` (seção "us5"), com um controle de que o wa-mock
   sim o apaga diante desse POST.
8. Token com sufixo `-sin-gestion` (sem `whatsapp_business_management`) → Salvar.
   ✅ A conexão é salva (200) e o aviso embaixo do formulário diz que não foi
   possível registrar o webhook e por quê; «Registrar na Meta» responde 422 com o
   mesmo motivo. Com um token normal, o botão volta a deixá-lo registrado.
