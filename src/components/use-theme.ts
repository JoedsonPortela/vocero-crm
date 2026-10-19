"use client";

import { useEffect, useState } from "react";
import type { ResolvedTheme } from "@/lib/theme";

/**
 * Tema realmente aplicado, lido do atributo `data-theme` do <html>.
 * Para os poucos lugares que calculam cor em JS (a pré-visualização da
 * marca): o CSS sozinho não basta porque a cor é escolhida pelo usuário.
 *
 * Começa em "light" e é corrigido após montar — no SSR não há DOM para ler.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const root = document.documentElement;
    const read = () =>
      setTheme(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
