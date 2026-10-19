# Roteiro E2E — US6: Modelos

> Conduzido com Playwright (MCP) contra `pnpm dev` com wa-mock.

## Ciclo de aprovação

1. Em `/settings/templates`: criar `seguimiento_cotizacion` (es_MX, UTILITY,
   corpo com `{{1}}`).
   ✅ Fica no estado "Pendente na Meta" (o mock devolve PENDING).
2. Simular a aprovação: `POST /api/dev/wa-mock/template-status`
   `{ wabaId, name, language, event: "APPROVED" }`.
   ✅ O estado passa a "Aprovado" (evento de webhook roteado por entry.id).
3. Caminho infeliz: criar `promo_rechazada` e simular `REJECTED` com motivo.
   ✅ Estado "Recusado" mostrando o motivo.
4. `POST /api/templates/sync` → 200 (pull pelo Graph; cobre o modo agência).

## Modo agência: aprovação que NUNCA chega por webhook

> Automatizado em `scripts/e2e-templates-sync.mjs` (13 checks) + conferência de
> UI com Playwright. Reproduz uma falha vista em produção.

`message_template_status_update` é entregue ao callback **no nível do app**, que
no modo agência não é o desta instância: sem o pull, o modelo fica "Pendente na
Meta" para sempre, mesmo que a Meta já tenha aprovado.

8. Criar modelo (UTILITY) e mover o painel simulado da Meta com
   `POST /api/dev/wa-mock/template-status` `{ event: "APPROVED",
   category: "MARKETING", notify: false }` — `notify:false` NÃO entrega webhook.
   ✅ O CRM segue em "Pendente na Meta" (a falha reproduzida).
9. `POST /api/templates/sync`.
   ✅ `updated: 1`, estado "Aprovado" e categoria **MARKETING** (a Meta é a
   autoridade da categoria: reclassifica ao aprovar e isso muda o custo).
   ✅ Um segundo sync devolve `updated: 0` (idempotente).
10. Abrir `/settings/templates` com o modelo pendente e a Meta já aprovado.
    ✅ O selo mostra "Aprovado" **sem tocar em Sincronizar** (sincronização
    automática ao montar); se o pull falhar, a lista local é pintada do mesmo
    jeito e o erro fica calado (só o botão manual informa erros).

## Envio com janela fechada

5. Abrir uma conversa com janela fechada na bandeja.
   ✅ O compositor bloqueado agora lista o modelo aprovado.
6. Escolhê-lo, preencher a variável e enviar.
   ✅ A mensagem aparece no fio (tipo modelo, corpo renderizado).
   ✅ A outbox do wa-mock registra `type: "template"` com `components`
   (`parameters[0].text` = valor da variável).
7. Validações: enviar modelo não aprovado → 422; variável faltando → 422.

## Várias variáveis por corpo (2026-08-09)

> Automatizado em `scripts/e2e-templates-multivar.mjs` (21 checks) + UI com
> Playwright. Antes o CRM recusava na própria tela o que a Meta aceita: "v1 admite
> uma única variável {{1}} no corpo".

11. Em `/settings/templates`, corpo com `{{1}}`, `{{2}}` e `{{3}}`.
    ✅ Sem aviso vermelho, o botão habilitado e a tela anuncia "3 variáveis".
    ✅ Para a Meta vai **um `example.body_text` por variável** (sem isso responde
    100).
12. Corpo com salto (`{{1}}` e `{{3}}`).
    ✅ Aviso "…sem saltos (falta {{2}})", botão desabilitado e, se forçado pela
    API, 422 — a numeração posicional contígua é exigência da Meta.
13. Com o modelo aprovado e a janela fechada, o envio pede **um campo por variável**
    (`Valor de {{1}}`…`{{3}}`).
    ✅ A outbox do wa-mock traz os 3 `parameters` em ordem e o fio mostra o texto
    já substituído.
    ✅ Faltando um valor → 422 dizendo qual falta; o wa-mock ainda replica o 132000
    da Meta se o número de parâmetros não bater.
14. Compatibilidade: o payload antigo `{ templateId, variable }` (uma variável)
    continua enviando — é o usado pelo cron de lembretes de sessão.
