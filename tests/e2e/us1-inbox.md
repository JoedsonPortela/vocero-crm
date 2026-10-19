# Roteiro E2E — US1: Bandeja do WhatsApp em tempo real

> Conduzido com Playwright (MCP) contra `pnpm dev` com o ambiente de testes
> interno ativo (`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock).
> Requer: usuário cadastrado e número conectado (mock, phoneNumberId `123456789`).

## Preparação

1. `DELETE /api/dev/wa-mock/outbox` — limpar o harness.
2. Login em `/login` e abrir `/inbox`.

## Caminho feliz

3. **Entrada em tempo real (SC-001)**: `POST /api/dev/wa-mock/inbound`
   `{ phoneNumberId, from: "5215522223333", name: "Cliente E2E", text: "Olá, têm furadeiras?" }`.
   ✅ A conversa aparece na lista em ≤2 s SEM recarregar, com nome e prévia.
4. **Abrir o fio**: clique na conversa.
   ✅ A mensagem de entrada aparece em bolha; o contador de não lidas zera.
5. **Responder**: digitar "Sim! Qual modelo você procura?" e enviar.
   ✅ A mensagem aparece no fio (direção de saída, relógio de pendente).
   ✅ `GET /api/dev/wa-mock/outbox` contém o envio com `to: 525522223333`
   (normalização MX) e o texto.
6. **Estados**: `POST /api/dev/wa-mock/status` com `delivered` e depois `read`.
   ✅ Os ticks avançam para ✓✓ e para ✓✓ azul sem recarregar.
7. **Avatares**: a conversa mostra as iniciais "CE" com cor estável.

## Envio instantâneo

Automatizado em `scripts/e2e-envio-instantaneo.mjs`.

8. **Enter não espera a Meta**: digitar uma linha e apertar Enter.
   ✅ O campo fica livre de imediato (menos de 300 ms), sem esperar a viagem até
   a Meta, que leva ~1,5 s.
   ✅ No fio já aparece a bolha com relógio de "enviando".
9. **Duas linhas seguidas**: sem esperar, digitar a próxima e apertar Enter.
   ✅ Saem DUAS mensagens separadas, não uma com tudo colado.
   ✅ Chegam ao WhatsApp na mesma ordem em que foram digitadas: os envios saem
   enfileirados, porque dois POST simultâneos podem chegar à Meta fora de ordem.
   ✅ Quando a mensagem real chega, a bolha provisória é retirada sem deixar
   duplicata e sem piscar.

## Ficha do lead

Automatizado em `scripts/e2e-ficha-lead.mjs`. `PUT /api/bot/ficha` já deixava o
agente guardar o que descobre; sem esta seção era uma gaveta que enchia e não
se abria.

10. **O que o agente sabe aparece.** No painel de detalhes, abaixo da etapa.
    ✅ As chaves se leem bonito (`dolor_principal` → "Dolor principal") sem
    alterar o salvo: renomeá-las quebraria o agente, que as busca exatas.
    ✅ Booleanos aparecem como Sim/Não — ninguém qualifica em `true`.
    ✅ Aparece ao vivo enquanto o agente conversa, sem recarregar.
11. **Dá para corrigir.** Um dado errado que o dono vê mas não consegue arrumar
    ensina a desconfiar da ficha inteira.
    ✅ Editar NÃO muda o tipo: `presupuesto: 50000` corrigido para "60000" continua
    sendo número, porque do outro lado há um bot que pode estar comparando.
    ✅ O ícone da lixeira remove a chave; esvaziar o campo NÃO a apaga.
12. **Ninguém pisa no trabalho do outro.** O agente segue escrevendo enquanto o
    dono corrige.
    ✅ É merge, não substituição: o novo do agente entra sem apagar a correção, e
    vice-versa.
    ✅ Objetos e arrays são ignorados em silêncio em vez de derrubar a ficha.
    ✅ Um contato de outra organização → **404**, não uma escrita às cegas.

## Caminhos infelizes

13. **Dedup (SC-004)**: enviar duas vezes o mesmo `waMessageId` `wamid.dedup.1`.
    ✅ O fio mostra UMA única vez a mensagem.
14. **Janela fechada (SC-005)**: entrada de contato novo com `timestamp` de há 25
    horas → abrir a conversa.
    ✅ O compositor está bloqueado com a explicação da janela e oferece modelos
    (estado vazio se não houver aprovados).
    ✅ `POST /api/conversations/:id/messages` responde 409 `window_closed`.
15. **Segmento de webhook incorreto**: `POST /api/webhooks/wa/token-falso` → 404 e
    não aparece nada novo na bandeja.
16. **Reconexão**: (coberto por desenho: o EventSource reconecta e o cliente
    refaz o fetch com o evento `open`; verificação funcional no checkpoint de
    compose).
