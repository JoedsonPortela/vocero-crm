# Roteiro E2E — US2: Contatos e pipeline kanban

> Conduzido com Playwright (MCP) contra `pnpm dev` com o ambiente de testes
> interno. Continua o estado do roteiro de US1 (contatos já criados por
> mensagens de entrada).

## Auto-registro (FR-010)

1. Abrir `/contacts`.
   ✅ Os remetentes de US1 ("Cliente E2E", "Cliente Frio") existem como contatos
   com o nome do perfil e o telefone.
2. Abrir `/pipeline`.
   ✅ Cada contato tem seu cartão na etapa "Novo" com última atividade.

## Kanban (FR-011/FR-012)

3. Arrastar o cartão "Cliente E2E" de "Novo" para "Em conversa".
   ✅ O cartão muda de coluna.
4. Recarregar a página.
   ✅ O cartão continua em "Em conversa" (persistência).
5. O cartão mostra contato + última atividade + link que abre a conversa dele na
   bandeja (`/inbox?contact=...`).

## Gestão de etapas (FR-011)

6. "Gerenciar etapas": renomear uma etapa, adicionar "Cotizado", verificar que as
   âncoras ganho/perdido não podem ser excluídas.
7. Excluir "Cotizado" (vazia) → desaparece.

## Diário de etapas

Automatizado em `scripts/e2e-bitacora-etapas.mjs`. O quadro diz onde cada lead
está HOJE; o diário é o que permite perguntar o que aconteceu antes.

8. **Nasce com seu evento**: provocar uma entrada de número novo.
   ✅ O lead aparece na primeira etapa e o seu primeiro movimento fica registrado
   (sem etapa de origem).
9. **Mover deixa registro**: arrastar o cartão para outra coluna.
   ✅ Fica um movimento com de onde, para onde, quando e quem o moveu.
   ✅ Reordenar dentro da MESMA coluna não cria um movimento.
10. **Perder exige motivo**: arrastar para a etapa perdida.
    ✅ Abre o diálogo. Se cancelar, o cartão nem se moveu.
    ✅ Por API sem motivo → **422** `loss_reason_required`, e o lead fica onde
    estava.
    ✅ Com motivo → o motivo e a nota ficam no diário.
    ✅ Um INSERT direto no banco de um movimento para "perdido" sem motivo é
    recusado pelo CHECK `lse_loss_reason_ck`: a regra não depende da rota.
11. **Todos os caminhos passam pela porta**: `POST /api/bot/reset` deixa o seu
    movimento como `sistema`, e excluir uma etapa com realocação deixa um evento
    por cada lead realocado.

## Cadastro manual de prospects

Automatizado em `scripts/e2e-alta-manual.mjs`. O funil já não depende de a pessoa
chegar pelo WhatsApp.

12. **"Novo contato"** em Contatos: nome, telefone, origem e etapa inicial.
    ✅ O prospect aparece no **Pipeline**, na etapa escolhida — não só na lista de
    contatos.
    ✅ O nascimento fica no diário marcado como capturado pelo dono.
13. **O telefone exige código do país.** Um número local criaria um contato que
    nunca casaria com as mensagens de entrada, porque a Meta manda a identidade
    completa.
    ✅ Com traços ou letras → **422** explicando a regra.
    ✅ Um telefone repetido → **409**, e se oferece abrir quem já existe em vez de
    um erro seco.
14. **A origem capturada manda; o que ninguém capturou não é inventado.**
    ✅ Quem chegou pelo WhatsApp fica "não identificado" e marcado como deduzido.
    ✅ A etiqueta de origem só aparece quando alguém a capturou.
15. **Escrever primeiro**: o botão de enviar abre o painel de modelos.
    ✅ Só modelos aprovados: iniciar com texto livre é proibido pela Meta.
    ✅ Com a janela de 24 h aberta, avisa em vez de gastar um modelo.

## Valor da negociação

Automatizado em `scripts/e2e-monto-pipeline.mjs`. O quadro conta pessoas; isto
acrescenta quanto dinheiro há em cada coluna.

16. **Capturar o valor** pelo cartão ("+ valor").
    ✅ Aceita o que se digita: `12500`, `12,500.50`, `$12 500`.
    ✅ Salvar **não move** o cartão, e mover o cartão não apaga o valor.
    ✅ Vazio apaga o valor: um negócio sem número não vale zero, não se sabe.
17. **Total por coluna** no pé de cada etapa.
    ✅ Soma só a moeda do negócio, em centavos inteiros.
    ✅ Sem valores capturados diz "Sem valores capturados" — um `$0.00` se lê como
    erro do sistema, não como dado.
    ✅ Se houver valores em outra moeda, diz isso em vez de descartá-los em
    silêncio.
18. **A moeda se escolhe** em Ajustes → Marca.
    ✅ O quadro a reflete.
    ✅ Um valor já capturado mantém a sua: trocar a configuração não reinterpreta
    pesos como dólares.

## Prioridade

Automatizado em `scripts/e2e-prioridad.mjs`. Para quem ligar primeiro.

19. **Quem define é o dono**, pelo cartão (Alta / Média / Baixa).
    ✅ Um lead novo nasce **sem** prioridade — não com uma "média" inventada.
    ✅ Pode ser **removida**: um clique errado não fica para sempre.
20. **Nada a escreve sozinho.** Mover o cartão de etapa, capturar o valor ou
    receber uma mensagem do cliente NÃO a mudam. É a única forma de o dono poder
    confiar que o que vê é o que ele pôs.
21. **Aparece onde se trabalha**: etiqueta no cartão do Pipeline e na lista de
    Contatos, que além disso ordena alta primeiro e deixa no fim quem não tem
    prioridade.

## O negócio, aberto pelo quadro

Conduzido com Playwright (MCP). Não traz roteiro automatizado próprio de propósito:
a gaveta não acrescenta comportamento de servidor — usa os mesmos endpoints que já
cobrem `e2e-monto-pipeline`, `e2e-prioridad`, `e2e-bitacora-etapas` e
`e2e-ficha-lead`. O que se verifica aqui é a fiação.

22. **Clique no cartão** (no corpo, não num controle).
    ✅ Abre uma gaveta com quem é, valor, prioridade, etapa e ficha, sem sair do
    quadro.
    ✅ **Arrastar continua funcionando**: o sensor só ativa o arraste a partir de
    6 px, então um clique parado nunca chega a ser arraste.
    ✅ E soltar depois de arrastar **não** abre a gaveta.
    ✅ Tocar em "+ valor" no cartão abre o diálogo dele e NÃO abre também a gaveta.
    ✅ Escape fecha; no celular ocupa 345 px de 375 sem rolagem horizontal.
23. **Edita-se de dentro** e o quadro reflete na hora.
    ✅ Prioridade, valor e etapa são salvos sem fechar a gaveta.
    ✅ A gaveta lê do quadro, não de uma cópia: o que se muda aparece.
24. **Perder exige motivo também daqui.** É a mesma porta do arraste, não uma
    segunda regra que pode ser esquecida.
    ✅ Mover para a etapa perdida abre o diálogo de motivo por cima da gaveta.
    ✅ Se cancelar, o lead fica onde estava e a gaveta segue aberta.

## Contatos (FR-013)

22. Buscar por "Frio" → filtra; editar notas → persiste; arquivar → desaparece da
    lista (visível com "Ver arquivados"); desarquivar → volta.
