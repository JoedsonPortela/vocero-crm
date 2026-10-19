# E2E — 003 Identidade resiliente (BSUID)

Pré-condição: app rodando com mocks (`WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock), organização criada e conexão WhatsApp salva
(assistente com credenciais do mock).

## Caminho feliz: entrada sem wa_id

1. `POST /api/dev/wa-mock/inbound` com `{phoneNumberId, fromUserId: "bsu_e2e_1",
   name: "Dueña Dental", text: "hola, vi su anuncio"}` (sem `from`).
2. Na bandeja: aparece a conversa "Dueña Dental" (NÃO "bsu_e2e_1") com a
   mensagem, em ≤2 s (SSE).
3. Painel do contato: mostra "Sem telefone".
4. Responder pelo compositor → a mensagem sai; na outbox do wa-mock o destinatário
   é `bsu_e2e_1` (o BSUID, não um telefone).
5. Reentregar o MESMO payload (mesmo `waMessageId`) → sem duplicatas.

## Reconciliação

6. `POST inbound` com `{from: "5215550001234", name: "Kevin"}` → contato A.
7. `POST inbound` com `{from: "525550001234", text: "sigo yo"}` → MESMO contato
   A (não aparece um segundo contato; normalização 521→52 na ingestão).
8. `POST inbound` com `{from: "525550001234", fromUserId: "bsu_kevin"}` → o
   contato A passa a ter o BSUID (verificável respondendo depois de simular a
   perda do telefone — fora do alcance da UI; verificar por API/BD).

## Caminho infeliz

9. `POST inbound` com payload sem `from` NEM `fromUserId` (montado à mão contra o
   webhook com assinatura válida) → 200, log de aviso, a bandeja NÃO mostra nada
   novo e a app continua de pé.
