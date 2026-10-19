# Roteiro E2E — Resultados: vendas, o agente, de onde chegam e o que se perde

> Automatizado em `scripts/e2e-resultados.mjs` (`pnpm test:e2e:resultados`,
> app no ar com os mocks). Spec: [019](../../specs/019-resultados/spec.md).
> Roda com a bandeira `AGENDA` desligada ou ligada: lê do mesmo ambiente que a
> app.

A instância pode trazer dados de outros roteiros, então o roteiro tira uma foto
das quatro seções ANTES de semear e outra DEPOIS, e compara a diferença. As linhas
por anúncio são exatas: seus `source_id` são da execução.

## Semeadura (caminhos reais)

Dez pessoas escrevem pelo webhook do wa-mock: três pelo anúncio R1 (com criativo),
uma pelo R2 (sem imagem), uma por uma **publicação**, uma que pede um humano, duas
orgânicas, uma cadastrada à mão como «indicado» que depois escreve, e uma que é
levada para o período anterior. O agente responde contra o ai-mock. Pela API do
pipeline: uma venda de $12,000, um negócio perdido por preço, outro
ganho-tirado-e-devolvido-a-ganho ($5,000), outro ganho e devolvido ao funil, um
valor de $3,000 num negócio aberto. A Meta recusa um envio (130472). Por SQL, só o
que o webhook não consegue fabricar: datas no passado (um lead em silêncio há 8
dias, uma janela prestes a fechar, o período anterior) e, com `AGENDA`, consultas
de cada desfecho mais uma de teste.

## Caminho verificado

1. Sem intervalo, as quatro seções respondem 200 com os últimos 30 dias no fuso do
   negócio. Um intervalo invertido, uma data inventada, uma que não existe (31 de
   fevereiro) ou de vários anos → **422 com mensagem**.
2. **Vendas**: +9 prospectos (+1 no anterior), +2 ganhos (o devolvido não conta; o
   ganho duas vezes, um), +1 perdido, +$17,000.00 ganhos, taxa de fechamento com o
   seu denominador, «preço» +1, funil (+9 na primeira etapa, +3 chegaram a Ganho),
   hoje no funil (+$3,000 abertos, +6 sem valor), um balde por dia do período e a
   série bate com os indicadores.
3. **Origem e anúncios**: +9 conversas (+1 no anterior); «Anúncio» +4/+4/+2; a
   publicação conta como «Não identificado», não como anúncio; o capturado
   («Indicado») manda; nem uma chave de gasto, custo ou retorno. R1 = 3 conversas,
   3 prospectos, 1 venda (33 % de 3, amostra pequena), com título e imagem servida
   por `/api/media`; R2 = 1/1/1 sem imagem; a publicação tem a sua linha marcada
   `post`. O `ctwa_clid` não aparece.
4. **O agente**: +9 conversas; «o agente respondeu» sobre as 9 com mensagem do
   cliente; +9 primeiras respostas medidas (também a escalada: o aviso «vou
   transferir para uma pessoa da equipe» é resposta do agente, com origem IA); +1
   «O cliente pediu um humano»; a ficha é medida sobre os contatos novos. Sem
   `AGENDA`: `sessions: null`. Com `AGENDA`: +4 consultas (a de teste não conta),
   +1 realizada, +1 não compareceu, +1 cancelada, comparecimento sobre as 2 com
   desfecho.
5. **O que está se perdendo**: +1 em silêncio com os seus $3,000 e 8 dias; +1
   mensagem que não chegou com o código da Meta; a janela prestes a fechar com ~3
   h.
6. **O Laboratório não existe para Resultados**: roda-se o Laboratório completo e
   inventa-se um lead para um dos seus contatos; nenhum número das quatro seções
   muda.
7. `/results` carrega com sessão e o menu leva até lá; sem sessão, as quatro rotas
   de análise respondem 401.

A responsividade de `/results` (sem corte na largura em celular, tablet e desktop)
é coberta por `scripts/e2e-responsive.mjs`.
