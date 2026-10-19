# E2E — Consultas no calendário (215)

Roteiro de comportamento observável. Automatizado em
`scripts/e2e-calendario.mjs`: com a app no ar e os mocks ligados,
`pnpm test:e2e:calendario` o conduz com Playwright e sai diferente de zero se
algo falhar.

**Preparação**: app em `localhost` com `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock e a BD migrada. O navegador roda em
`Asia/Tokyo` e o negócio em `America/Mexico_City` (15 h de diferença): tudo o
que é pintado ou bloqueado tem que sair na hora do NEGÓCIO. A bandeira `AGENDA`
decide qual metade roda.

---

## Com `AGENDA` desligada

1. `GET /api/bookings`, com ou sem `from`/`to` (também malformados), é **404**.
2. A tela `/bookings` é 404 e a navegação não oferece «Consultas».

## A API por intervalo

1. Sem parâmetros, `GET /api/bookings` responde **exatamente** `{ bookings }`
   (as últimas 200): é o que lê o roteiro de 015.
2. Com `?from=AAAA-MM-DD&to=AAAA-MM-DD` traz todas as consultas que tocam esses
   dias do negócio, em ordem, mais `timezone`, `weeklyHours`, `range` e
   `truncated`.
3. Só um dos dois, uma data inexistente, o intervalo invertido ou mais de 92
   dias: **422** `invalid_range`. 92 dias exatos cabem.
4. **Falha 4** (antes, as últimas 200): com 205 bloqueios em junho, sem intervalo
   continuam chegando 200 e o intervalo de junho traz os 205.

## O calendário

1. `/bookings?vista=semana&fecha=D` pinta a semana; a consulta das 10:00 fica na
   altura das 10:00 do negócio (não de Tóquio) e o canto diz «GMT-6».
2. Uma consulta do Laboratório (`is_test`) na mesma hora não é pintada; o
   interruptor «Mostrar testes» a mostra e desligá-lo a oculta.
3. «Semana seguinte» move a data da URL 7 dias; «Hoje» volta ao hoje do negócio;
   Dia, Mês (grade com «Ver o dia N») e Lista (`desde`/`até`) mudam a URL.
4. Tocar a consulta abre o painel com «Abrir conversa» (→
   `/inbox?contact=…`), «Remarcar», «Realizada», «Não compareceu» e «Cancelar
   consulta». Abri-lo NÃO pede disponibilidade.
5. **Falha 2** (antes, 12 vagas): «Remarcar» pede a disponibilidade uma única vez
   e oferece as vagas de toda a janela por dia (≥ 5 dias, > 12 vagas). Escolher
   uma move a consulta, o painel diz a hora nova e o calendário mostra esse dia.
   Escape fecha o painel.
6. **Falha 1** (antes, a hora do navegador): tocar o espaço vazio das 15:10 abre
   «Bloquear horário» com esse dia e as 15:00; ao confirmar, o bloqueio fica às
   15:00 da Cidade do México (21:00 UTC), não às 15:00 de Tóquio, e aparece
   listrado.
7. **Falha 3** (antes, cada evento recalculava a disponibilidade): cinco
   bloqueios criados de fora aparecem sozinhos por SSE, sem uma única requisição
   de disponibilidade e com no máximo uma consulta do intervalo por evento.
8. Num celular sem preferência salva abre em «Dia» e a página não estoura a
   largura.

Ao terminar, cancela o que foi criado e apaga a consulta de teste.
