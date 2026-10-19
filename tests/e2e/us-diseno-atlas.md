# Roteiro E2E — 002: Redesenho Atlas + White-label

> Conduzido com Playwright (script) contra `pnpm dev` com mocks.

## Regressão funcional sobre o redesenho (executado ✅)

1. Entrada mock → visível na bandeja SEM recarregar (SSE). ✅
2. Abrir conversa → responder pelo compositor novo (Enter envia). ✅
3. Recolher o painel de detalhes (chevron) → reabrir pelo cabeçalho do chat;
   preferência persistida no localStorage. ✅
4. Conversa com janela fechada → aviso + seletor de modelo aprovado. ✅
5. Stepper de etapas no painel → clique num passo move o lead (PATCH 200) e o
   kanban reflete. ✅
6. Filtros Todas/Não lidas e busca na lista. ✅ (visual)

## White-label (executado ✅)

7. PUT nome «El Martillo» + acento Verde apagado →
   ✅ marca da navegação, `<title>` e variável CSS `--accent: #3f6b66` aplicados
   (SSR, `router.refresh()`); o login PÚBLICO mostra a marca; restaurar os
   padrões funciona.
8. Só o proprietário pode mudar a marca (PUT com papel de membro → 403).
9. Testes unitários: predefinições exatas, derivação de cor personalizada com
   ajuste de contraste, normalização (vazio→padrão, hex inválido→padrão). ✅

## Tema escuro

Conduzido com Playwright (MCP). A preferência é **por dispositivo** (cookie), não
por conta: quem trabalha de noite no notebook e de dia no escritório não quer
arrastar a mesma escolha para os dois lugares.

10. **Alternar pela barra lateral** muda o tema e persiste ao recarregar. ✅
    Sem piscada: o layout raiz escreve `data-theme` no HTML do servidor, então o
    tema já vem resolvido no primeiro byte. Resolver no cliente daria um flash
    branco a cada carregamento, que num app usado de noite é exatamente o que se
    queria evitar.
11. **O acento da marca clareia no escuro.** As predefinições são calculadas para
    fundo claro e sobre o fundo escuro afundam.
    ✅ `resolveAccentSet(hex, "dark")` sobe a cor até **≥ 3.5:1** contra o fundo
    do tema, e as variantes soft/tint se misturam para o fundo escuro, não para
    o branco.
    ✅ Sobre um acento já clareado, a tinta em cima deixa de ser branca quando não
    seria legível (`fg` cai para escuro abaixo de 3:1).
12. **Os dois temas viajam no mesmo CSS.** O servidor nem sempre sabe qual será
    resolvido (preferência «sistema»), então emite os dois blocos.
    ✅ Texto e superfícies usam tokens semânticos, não cores soltas: trocar de
    tema não deixa nenhum elemento com a cor do outro.

## Versão visível

Automatizado em `tests/unit/version.test.ts`; a parte do deploy é verificada com
um `curl`. Responde "já foi implantada a minha mudança?" sem entrar no servidor.

13. **Embaixo na barra lateral**: `v1.2.0 · 8e62d0b`.
    ✅ O nome do tooltip sai da **marca**, não fixo: uma instância renomeada não
    deve dizer "Vocero" justo ali.
    ✅ Contraste ≥ 4.5:1 no claro e no escuro — discreta, mas não ilegível.
14. **Também em `/api/health`**, para confirmar um deploy por script ou pela
    plataforma de hospedagem, sem abrir o app nem fazer login.
    ✅ `{"ok":true,"version":"1.2.0","commit":"8e62d0b","commitVerified":true}`.
15. **O commit se resolve por dois caminhos, e só um está verificado.** O do build
    manda; se quem construiu não o passou, vale o que a plataforma anuncia em
    execução — mas marcado como NÃO verificado (#50).
    ✅ Construir SEM `SOURCE_COMMIT` e iniciar COM ele no ambiente mostra o commit
    igual: sem esse respaldo o distintivo ficava só com a versão, que não se move
    entre deploys do mesmo release.
    ✅ …e o mostra pelo que é: «commit não verificado» no distintivo e
    `"commitVerified":false` em `/api/health`. Uma variável de ambiente escrita à
    mão uma vez fica parada enquanto o app avança; apresentá-la como se viesse do
    build é o distintivo mentindo (#50, ponto 4).
    ✅ Sem nenhum dos dois, vê-se só a versão. Nunca quebra o build.

## Ícone da aba

Automatizado em `scripts/e2e-favicon.mjs`. Com cinco instâncias abertas em abas,
o ícone genérico do navegador as torna indistinguíveis.

16. **Toda instância tem ícone sem configurar nada.**
    ✅ `GET /api/branding/favicon` devolve um SVG com a inicial sobre o acento, e
    responde **sem sessão** — o login também tem aba.
    ✅ Se o arquivo enviado se perder (volume não montado), cai no gerado em vez
    de deixar a aba vazia: um 404 ali parece instância quebrada.
17. **O dono envia o seu logo** em Configurações → Marca (PNG, SVG, ICO, JPEG,
    WebP).
    ✅ É servido byte a byte com o seu tipo real.
    ✅ Pode ser **removido** e voltar ao gerado.
    ✅ Salvar nome ou cor **não** apaga o logo: são formulários diferentes.
18. **Não entra um documento disfarçado de imagem.** O tipo sai dos BYTES, não do
    `content-type` que o cliente declarar.
    ✅ Declarar `image/png` e enviar HTML → **422**, e o ícone bom intacto.
    ✅ Mais de 256 KB → **413**. Corpo vazio → **422**.
    ✅ Todo ícone é servido com `Content-Security-Policy: default-src 'none'` e
    `nosniff`: um SVG enviado não executa nada se alguém navegar até a sua URL.
19. **O navegador solta o ícone velho.** A URL leva `?v=`.
    ✅ Muda ao enviar, ao remover e ao trocar nome ou acento.
    ✅ Remover e enviar de novo **não repete** uma URL já em cache.

## Logo na barra lateral

Automatizado em `scripts/e2e-favicon.mjs`, na mesma execução do ícone. O arquivo
que o dono envia é UM e serve para as duas coisas: antes só mudava a aba, e a
barra lateral seguia com a inicial.

20. **O logo enviado aparece onde a marca aparece**: barra lateral, barra
    superior do telefone, login e prévia em Configurações → Marca.
    ✅ O mosaico o desenha com a MESMA URL versionada da aba (`?v=u<versão>`): ao
    trocá-lo, a barra não fica com o anterior.
    ✅ O login também o mostra, sem sessão.
    ✅ Removê-lo devolve a inicial na barra, sem imagem quebrada.
    ✅ Vence mesmo que a instância se chame Vocero: quem envia um arquivo quer vê-lo
    no lugar do "v".
    ✅ A prévia de Configurações → Marca o acompanha ao enviar e ao remover, sem
    recarregar (a marca chega por prop do servidor, que é atualizado).
21. **Um logo que não é quadrado não é deformado.** `object-contain` dentro do
    mosaico; o que sobra é preenchido pelo degradê do acento. O cartão, que agora
    se chama «Logo do negócio», avisa: quadrado e com fundo transparente fica
    melhor. (Capturas, não automatizado.)

## Fidelidade visual (julgamento humano pendente)

Capturas em `docs/screenshots/` comparadas com o handoff: layout de 4 colunas,
tokens, bolhas, stepper, chips. Revisão estética final: Kevin.
