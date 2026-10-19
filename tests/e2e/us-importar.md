# E2E — Importar contatos e «sem agente» (027)

Chicote: `scripts/e2e-importar.mjs`. Spec:
[`specs/027-importar-contactos/spec.md`](../../specs/027-importar-contactos/spec.md).

Pré-condição: app rodando (`next dev`) sobre uma base migrada, **sem**
`BRAIN_DISPATCH_URL` (responde o agente incluído), com simuladores
(`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock, `OPENROUTER_BASE_URL`
→ ai-mock com `OPENROUTER_API_TOKEN` e `OPENROUTER_MODEL`) e
`AGENT_COALESCE_MS=1500`.

O chicote importa pela mesma rota que usa o diálogo (`POST
/api/contacts/import`), faz os importados escreverem pelo WhatsApp e confere o
que ficou em Contatos e na bandeja.

```bash
node --env-file=.env scripts/e2e-importar.mjs
```

## Um arquivo de 50 linhas

1. 50 linhas boas, com os telefones como vêm numa planilha (`+52 1…`, com
   espaços, sem o 1), mais quatro que não servem → 200, `created: 50`, e as quatro
   voltam com a sua linha e o seu motivo (`sin_codigo_pais`, `repetido`,
   `telefono_invalido`, `sin_telefono`).
2. As 50 aparecem em Contatos, salvas como a ingestão as salva (`52…` e dez
   dígitos), com agente e fora do Pipeline. Não nasce nenhuma conversa.
3. Importar o mesmo arquivo de novo → `created: 0`, `existing: 50`. Continuam
   sendo 50.

## «O agente não responde a eles»

4. Alguém que já escrevia (conversa com agente, que lhe respondeu) entra num
   arquivo importado com a caixa marcada, junto de uma pessoa nova e uma linha sem
   nome → `created: 2`, `existing: 1`, `paused: 3`.
5. A pessoa nova existe uma única vez, «sem agente», sem etapa e sem conversa. Em
   quem já existia o nome não foi trocado, e a conversa dele ficou com a IA
   pausada.
6. O importado escreve: a conversa dele nasce com a IA pausada, cai na mesma ficha,
   mantém o nome do arquivo (não o do perfil do WhatsApp) e fica não lida. O
   agente não lhe responde, nem a quem já existia.
7. A linha sem nome entrou com o telefone como nome, e pega o do WhatsApp assim
   que escreve.
8. A um desconhecido o agente sim responde.
9. `PATCH /api/contacts/{id}` com `aiPaused: false` → o contato deixa de estar
   «sem agente», a conversa dele volta a ter IA e na mensagem seguinte o agente
   responde. Editar outra coisa do contato não mexe na pausa.

## O que não é importado

10. Nenhum telefone válido → 422 `nothing_to_import`. Lista vazia → 422. Mais de
    2.000 linhas → 422, sem importar nenhuma. Sem sessão → 401.

## Interface (à mão, claro e escuro)

- Contatos → «Importar»: um CSV como o Excel em português o exporta (BOM,
  ponto e vírgula, «Telefone» com acento, sobrenomes na sua coluna, um nome com
  vírgula entre aspas). A prévia diz quantos entram, mostra os primeiros e lista
  os que ficam de fora com o seu motivo.
- Depois de importar com a caixa marcada, a lista mostra «Sem agente».
- «Editar» de um contato traz a caixa «O agente não responde a ele».
