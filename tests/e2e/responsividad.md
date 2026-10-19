# Responsividade — o CRM é usado pelo telefone

Roteiro de comportamento (2026-08-14). Automatizado em
`scripts/e2e-responsive.mjs`.

Origem: o app foi desenhado para desktop: a lateral fixa de 224 px e a Bandeja de
três colunas. Abaixo de ~1000 px a lateral comia metade da tela, o fio ficava
numa faixa de uns 100 px e o compositor caía para fora da área visível do
navegador móvel.

## Preparação

App rodando com mocks (`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` →
wa-mock) e BD com migrações aplicadas. Um contato de entrada de teste com
conversa aberta.

Três tamanhos: telefone 390×844, tablet 820×1180, desktop 1440×900.

## AC-1 — Nenhuma tela corta conteúdo na largura

Percorre Bandeja, Pipeline, Contatos, Agente, Laboratório e
Ajustes → WhatsApp nos três tamanhos.

Esperado: em cada uma, o conteúdo de `main` cabe na sua largura visível
(`scrollWidth == clientWidth`) e o documento não gera rolagem horizontal. O
quadro do Pipeline sim se arrasta na horizontal, mas **dentro** do seu próprio
contêiner, com as colunas ancoradas (snap).

## AC-2 — A lateral vira gaveta no telefone

1. Abra qualquer tela em 390×844.

Esperado: aparece a barra superior com o hambúrguer e a marca; os links da
lateral **não** são alcançáveis (estão fora da ordem de tabulação).

2. Toque no hambúrguer.

Esperado: a gaveta entra pela esquerda **por cima** do conteúdo (não o empurra:
`main` continua começando em x=0), com véu atrás.

3. Toque em "Bandeja".

Esperado: navega e a gaveta fecha sozinha. Também fecha com Escape, com o véu e
com o próprio ✕.

## AC-3 — A Bandeja é mestre-detalhe no telefone

1. Abra a Bandeja sem conversa escolhida.

Esperado: a lista ocupa a largura toda (390 px), não uma coluna de 360 px com o
fio espremido ao lado.

2. Toque numa conversa.

Esperado: o fio ocupa a tela toda, a lista some e aparece um botão "Voltar às
conversas" que a traz de volta.

3. Olhe o compositor.

Esperado: fica **dentro** da tela (a altura do casco é `100dvh`, não `100vh`) e
sua tipografia mede ≥16 px, que é o que evita o zoom do Safari no iOS ao focar
e deixar o CRM desalinhado. Vale o mesmo para todo campo de texto abaixo de `md`.

## AC-4 — Os detalhes do contato flutuam sobre o fio

1. Com o fio aberto no telefone, toque em "Mostrar detalhes".

Esperado: o painel começa **fechado** (a preferência salva só vale no desktop) e
entra como gaveta colada na borda direita, por cima do fio, sem roubar largura
nem provocar rolagem horizontal. Fecha pelo seu ✕ ou pelo véu.

Abaixo de `xl` (1280 px) o painel é sempre gaveta; a partir daí volta a ser a
terceira coluna.

## AC-5 — No tablet convivem lista e fio

Em 820×1180 a Bandeja mostra duas colunas (lista ~300 px + fio), e o painel de
detalhes continua sendo gaveta.

## AC-6 — No desktop nada mudou

Em 1440×900: lateral fixa de 224 px sem hambúrguer, Bandeja de três colunas
(lista 360 px + fio + detalhes 320 px) e a preferência de "painel aberto"
salva como sempre.

## AC-7 — Barra bicolor e interruptores

1. Com o tema claro, olhe a barra lateral.

Esperado: azul-marinho com texto claro, mesmo com a página branca. O app é
bicolor nos dois temas; o destaque da barra é o white-label calculado para fundo
escuro.

2. Alterne «IA nesta conversa» (Bandeja) e o interruptor do Agente.

Esperado: nos dois estados a bolinha fica **dentro** da pista, colada na
extremidade que lhe cabe (#53: a do Agente começava no centro e, ligada, ficava
para fora). Um clique a muda, e a Barra de espaço, com o foco nela, também. Sem
provedor de IA, a do Agente aparece esmaecida e não reage.
