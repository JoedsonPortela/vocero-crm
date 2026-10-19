# E2E — Atribuição de anúncios e Conversions API (016)

Roteiro de comportamento observável. Automatizado na seção `016` de
`scripts/e2e-selftest.mjs`: com a app no ar e os mocks ligados,
`pnpm test:e2e` o conduz e sai diferente de zero se algo falhar.

**Preparação**: app em `localhost` com `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock, `BOT_API_KEY` e a BD migrada. A bandeira
`ATRIBUCION` decide qual metade do roteiro roda: **as duas são exercitadas**,
porque uma funcionalidade opcional que só é testada ligada não está testada.

Nada disto toca a Meta. Não é comodidade: a Meta valida o `ctwa_clid` contra um
clique real e recusa qualquer valor inventado (`code 100 / error_subcode
2804087`), então um evento sintético contra a API real é impossível por
desenho. O mock imita as três coisas que importam: o catálogo fechado, a
exigência do clid e o **200 que descarta o evento**.

---

## US1 — A instância decide se isto existe

Com `ATRIBUCION` ausente:

1. `GET`/`PUT`/`DELETE /api/settings/capi` e `GET /api/settings/capi/events`
   respondem **404** (não 403: aqui esse endpoint não existe).
2. A tela `/settings/ads` responde 404 e Ajustes não a menciona.
3. Uma mensagem que **vem** de um anúncio é atendida como qualquer outra: a
   conversa é criada e a mensagem aparece. Desde 018 **a origem do anúncio é
   vista igual** (título na lista), mas é salva **sem** `ctwa_clid`: o detalhe
   diz `hasCtwaClid: false` e o valor não aparece em nenhuma resposta.

Com `ATRIBUCION=on`, as mesmas rotas respondem normalmente.

## US2 — Conectar o dataset

1. Sem configurar, `GET /api/settings/capi` responde **200 com `capi: null`**:
   não é erro, é uma instância que ainda não conectou.
2. Salvar **sem token** reusa o da conexão do WhatsApp; o `GET` seguinte mostra
   só os **últimos 4** caracteres e o token completo não aparece em lugar nenhum.
3. Um `qualifiedStageId` que não é deste negócio é recusado com
   **`422 etapa_invalida`**.
4. Desconectar apaga a configuração mas **não** os eventos já reportados: isso já
   foi dito à Meta e continua verdadeiro.

## US3 — Capturar o anúncio

1. Uma entrada com `referral` deixa a origem salva junto da conversa.
2. Uma segunda mensagem do mesmo contato com **outro** `ctwa_clid` não a
   sobrescreve: **o primeiro referral vence**, e isso se confere olhando com qual
   clid saiu o evento depois.

## US4 — O lead qualificado

1. Mover o lead para a etapa marcada como qualificada reporta `QualifiedLead`, e
   a atividade o mostra **enviado** com seu `fbtrace_id`.
2. O payload que a Meta recebeu leva o `ctwa_clid` correto e
   `custom_data.lead_stage = "qualified"` — sem esse parâmetro, nenhuma conversão
   personalizada da Meta poderia casar.
3. A linha de atividade diz **de qual anúncio** veio (seu título).
4. Tirar o lead dessa etapa e voltar a colocá-lo **não** reporta duas vezes.

## US5 — A venda

1. Mover o negócio para a etapa ganha, com valor, reporta `Purchase` com
   `value: 450.5` e sua moeda — **unidades, não centavos**.
2. Ganhar de novo o mesmo negócio não manda uma segunda compra.

## Caminhos infelizes (os que realmente importam)

1. **Lead sem anúncio**: a linha fica **omitida** com o motivo escrito
   (`sin ctwa_clid…`) e nada falha.
2. **A Meta recusando** (dataset `-fail`, que responde 200 com
   `events_received: 0`): o lead **move-se igual** e fica na etapa nova; a linha
   fica **com falha** com o que a Meta disse. Nenhuma conversão vale um
   movimento de lead bloqueado.

---

## 018 — De qual anúncio veio cada conversa (sempre visível)

Automatizado na seção `018` de `scripts/e2e-selftest.mjs` (dados, com a bandeira
**desligada e ligada**) e em `scripts/e2e-anuncio-origen-ui.mjs` (navegador: claro
e escuro, 1440 e 390 px). As criativas são servidas pelo wa-mock
(`/api/dev/wa-mock/media-file/creativo-*`), na origem de `META_GRAPH_BASE_URL`:
a única que a cópia aceita fora dos hosts da Meta, e só com os mocks habilitados.

### Captura

1. Uma primeira mensagem com `referral` deixa o anúncio na lista (título, id,
   tipo) e no detalhe do contato (link, texto, tipo de mídia, data).
2. `hasCtwaClid` é `true` só com a bandeira ligada; o valor do `ctwa_clid` não
   aparece em nenhuma resposta, ligada ou desligada.
3. Um contato sem origem capturada que chegou de um anúncio tem origem
   **deduzida «anúncio»**; uma publicação (`source_type: "post"`) é mostrada mas
   não conta como anúncio.
4. A reentrega da mesma mensagem não a duplica, e uma segunda mensagem com
   **outro** anúncio não muda o primeiro.
5. Um `referral` sem `source_id`, `ctwa_clid`, `headline` nem `source_url` não
   cria anúncio, e a mensagem entra.

### A imagem

1. É copiada sozinha e servida como PNG por `/api/media/{id}` com sessão; sem
   sessão, 401.
2. Outra pessoa do mesmo anúncio compartilha a mesma imagem.
3. Um host que não é da Meta, um redirecionamento para outro host, um SVG e uma
   imagem de mais de 300 KB ficam **sem imagem**, com o cartão e a mensagem
   intactos.
4. Um download que trava uma vez chega com a nova tentativa; um que falha duas
   vezes chega sem imagem e **abrir o contato a repara**.

### Na tela

1. A linha diz «Anúncio · título»; a orgânica, nada.
2. O filtro **Anúncios** aparece e deixa só as conversas de anúncio.
3. O painel mostra o cartão com a imagem **carregada** (não um ícone quebrado),
   «Ver anúncio» com o link https da Meta, «com vídeo» num anúncio de vídeo, e
   «A Meta identificou o clique» só com a bandeira ligada.
4. Uma conversa orgânica não mostra cartão.
5. O mesmo cartão sai na gaveta do negócio no pipeline.
6. A 390 px, a bandeja e o painel com o cartão não estouram a largura.

**Pendente de verificação humana**: um clique real num anúncio CTWA para um
número conectado. O mock reproduz a forma do `referral` da documentação da Meta,
não um clique.
