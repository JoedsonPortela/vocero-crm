# Roteiro E2E — Busca da Bandeja e filtro por etapa do funil

> Automatizado em `scripts/e2e-search-filters.mjs` (26 checks, Playwright
> contra `pnpm dev` com wa-mock). Nasce do relato do Kevin de 2026-08-05:
> «escribo Kevin en el buscador y no me da los resultados».

## A falha original: digitar enquanto a página ainda carrega

A caixa de busca é pintada no HTML do servidor, então dá para escrever nela antes
de o React hidratar. Ao montar, o React a deixava vazia e essas teclas se
perdiam **em silêncio**: o usuário via a bandeja inteira sem filtrar. Por isso o
input é NÃO controlado (`defaultValue` + ref) e, ao montar, adota o que já
estiver no DOM.

1. Abrir `/inbox` e escrever no buscador **antes** de aparecerem as conversas
   (`waitUntil: "commit"`).
   ✅ O texto continua na caixa depois da hidratação.
   ✅ A lista fica filtrada por essa pessoa.

## Busca tolerante (Bandeja, cliente — `matchesQuery`)

2. `jose` encontra «Josué Ramírez»; `RAMÍREZ` também.
   ✅ Acentos e maiúsculas indiferentes nos dois sentidos.
3. Telefone **como aparece na tela**: `+52 462 555 0101`, `462 555`,
   `462-555-0101`.
   ✅ Coincidem — a comparação é por dígitos (o banco guarda `524625550101`).
4. `vi su anuncio` (texto da última mensagem) → **não** coincide.
   ✅ O buscador olha nome e telefone, nada mais. Incluir a prévia fazia que
   buscar o nome do dono devolvesse 17 de 32 chats, porque o agente o escreve nas
   próprias mensagens. E era uma busca de mensagens pela metade: só a última de
   cada fio.
5. `zzz-no-existe` → lista vazia; o botão ✕ limpa e devolve tudo.
6. `46` (dois dígitos) **não** casa telefones.
   ✅ Mínimo de 3 dígitos: senão um dígito solto varreria o diretório.

## Filtro por etapa do funil

7. Bandeja: seletor junto de «Todas / Não lidas», com as etapas presentes.
   ✅ Filtrar deixa só essa etapa; «Toda etapa» restaura.
   ✅ Busca + etapa se combinam (nunca se contradizem).
8. Contatos: seletor com as etapas do pipeline **completo** (ordem real, via
   `GET /api/pipeline/stages`), e a etapa pintada em cada ficha.
   ✅ Filtrar por etapa consulta o servidor (`?stage=`), aplicado ANTES do corte
   de 200 para que ninguém dessa etapa fique de fora.
9. Caminho infeliz: uma etapa sem contatos não quebra a tela.
   ✅ Estado vazio honesto («Sem resultados», não «Sem contatos»).

## Busca do servidor (Contatos)

10. `jose` → «Josué Ramírez»; `+52 462 555 0101` → o contato com esse número.
    ✅ Espelho em SQL de `matchesQuery`: `translate()` para os acentos (sem
    depender da extensão `unaccent`) e `regexp_replace` para os dígitos.
    ✅ Os curingas de LIKE (`%`, `_`) são escapados: digitar `%` não lista tudo.
