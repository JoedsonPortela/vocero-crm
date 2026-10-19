# E2E — Excluir uma conversa (026)

Chicote: `scripts/e2e-eliminar.mjs`. Spec:
[`specs/026-eliminar-conversacion/spec.md`](../../specs/026-eliminar-conversacion/spec.md).

Pré-condição: app rodando (`next dev`) sobre uma base migrada, com
`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock e `MEDIA_DIR`.

Dois modos, conforme a app foi iniciada; a execução completa são as duas:

- **Com cérebro**: `BRAIN_DISPATCH_URL=http://127.0.0.1:<porta>/vocero/dispatch`
  e `BOT_API_KEY`. O chicote levanta esse cérebro no seu próprio processo, verifica
  a assinatura sobre o corpo cru e guarda o que recebe.
- **Sem despacho**: não há a quem avisar (`agente: "no_aplica"`).

Com `AGENDA=on` roda também a consulta futura.

```bash
node --env-file=.env scripts/e2e-eliminar.mjs
```

## Quem pode (AC5)

1. Um membro da equipe → 403, com e sem `?contacto=1`.
2. Uma conversa que não existe → 404.
3. A conversa continua na bandeja, com a sua mensagem.

## O fio (AC1, AC2, AC3, AC10)

4. A conversa tem uma mensagem com imagem: pode ser aberta
   (`/api/media/{assetId}` → 200) e o seu arquivo está em `MEDIA_DIR`. O contato
   tem notas, ficha e etapa.
5. `DELETE /api/conversations/{id}` → 200 `{ ok, alcance: "hilo", agente }`.
   Ela já não aparece na bandeja e as suas mensagens não existem.
6. O contato continua, com a sua nota, na mesma etapa e com o mesmo lead; a sua
   ficha ficou vazia.
7. O anexo responde 404 e o seu arquivo já não está no volume.
8. Pelo SSE chega `conversation.deleted` com `conversationId`, `contactId` e
   `contactDeleted: false`, e nada mais.
9. Excluí-la de novo → 404.

## O aviso ao cérebro (AC7, com cérebro)

10. Chega **um** `conversation.deleted`, assinado como um turno, com
    `x-vocero-event: conversation.deleted`, `x-vocero-organization` e sem
    `x-vocero-dispatch-id`. As chaves vêm na ordem do contrato; diz a conversa, o
    canal, o contato e a sua identidade, com um `eventId` próprio e a hora. Não
    leva nada do que foi apagado.

## Se volta a escrever (AC9)

11. A mesma pessoa escreve: conversa nova do mesmo contato, com outro id e uma
    única mensagem. Para o cérebro chega como uma conversa nova.

## O contato (AC4)

12. `DELETE …?contacto=1` → 200 `alcance: "contacto"`. O contato responde 404 e não
    aparece em Contatos nem no Pipeline. Se a pessoa voltar a escrever, é outro
    contato e outra conversa.

## O cérebro não confirma (AC8, com cérebro)

13. O cérebro responde 500 → exclui-se igual, `agente: "sin_confirmar"`, e não se
    tenta de novo. Com o cérebro desligado → o mesmo, em menos de 10 segundos.

## Uma consulta futura (AC6, com `AGENDA=on`)

14. Com uma consulta agendada futura, excluir a conversa ou o contato → 409
    `cita_pendiente` que diz a data e manda para Consultas. Nada é apagado.
15. Cancelada a consulta, a exclusão é feita; a consulta cancelada fica no
    histórico do contato, sem conversa.

## Interface (à mão, claro e escuro)

- Em Detalhes, no fim: «Excluir conversa…». Um membro da equipe não a vê.
- O diálogo diz o que vai e o que fica, e muda com a caixa «Apagar também o
  contato e o seu lead». Escape cancela; Enter não confirma.
