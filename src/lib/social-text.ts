/**
 * 024 — O texto da IA, sem formatação, para os canais que não a desenham.
 *
 * O agente incluído e os cérebros externos escrevem como se tudo fosse
 * WhatsApp: `*negrito*`, `_itálico_`, e às vezes Markdown inteiro. O WhatsApp
 * desenha; Instagram, Messenger e TikTok mostram os asteriscos como estão. Aqui
 * se tiram as marcas e se mantém o conteúdo.
 *
 * Puro e sem dependências: o servidor o usa ao enviar. É idempotente
 * (aplicá-lo duas vezes dá o mesmo que uma), o que permite tentar um
 * envio de novo sem medo.
 *
 * O que NÃO é: um interpretador de Markdown. É conservador de propósito: uma marca
 * só é removida se abre colada a uma palavra e fecha colada a outra, que é
 * como um modelo as escreve. `2 * 3 * 4`, `mi_variable` ou `5*3` não são
 * formatação e continuam como estão.
 */

// Marcadores de um só caractere (WhatsApp e Markdown): *x*, _x_, ~x~, `x`.
// Abre no início, após um espaço ou após um sinal de abertura; fecha antes de
// um espaço, um sinal de pontuação ou o fim.
const SIMPLE =
  /(^|[\s(¿¡"'«])([*_~`])(?=\S)([^\n]*?\S)\2(?=$|[\s.,!?;:)"'»…])/gm;

export function plainSocialText(text: string): string {
  // As URLs são separadas primeiro: seus sublinhados não são itálicos e seus
  // asteriscos não são negritos.
  const urls: string[] = [];
  const guardar = (url: string) => {
    urls.push(url);
    return `\u0000${urls.length - 1}\u0000`;
  };

  let out = text
    // [texto](https://…) → texto: https://…  (se o texto FOR a URL, só a URL)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      label.trim() === url ? guardar(url) : `${label}: ${guardar(url)}`
    )
    .replace(/https?:\/\/[^\s<>]+/g, guardar)
    // Blocos entre ``` → o seu conteúdo.
    .replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n$/, ""))
    // # Título → Título
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "$1")
    // - um · * um · + um → • um
    .replace(/^([ \t]*)[-*+][ \t]+(?=\S)/gm, "$1• ")
    // Marcadores duplos de Markdown.
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([^\n]*?\S)__/g, "$1")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");

  // Os simples podem vir aninhados (`*_oi_*`): repete-se até não restar
  // nenhum. O limite evita um laço com uma entrada estranha.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(SIMPLE, "$1$3");
    if (next === out) break;
    out = next;
  }

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)] ?? "");
}
