import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { AvisoIa } from "@/server/ai/aviso";

/**
 * A faixa que diz que o agente não consegue responder (issue #85).
 *
 * Não é descartável. Um banner que se fecha é um banner que se fecha uma vez e
 * nunca mais é visto, e isso não é novidade: é o produto não estar
 * fazendo o que o dono acha que faz. Some sozinho quando é corrigido.
 */
export function AvisoIaBanner({ aviso }: { aviso: AvisoIa }) {
  if (!aviso) return null;
  return (
    <div
      role="status"
      data-aviso-ia
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning-soft bg-warning-tint px-4 py-2.5 text-[13px] text-warning-text"
    >
      <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.7} />
      <span className="min-w-0 flex-1">{aviso.mensaje}</span>
      <Link
        href="/settings/ai"
        className="shrink-0 font-medium underline underline-offset-2"
      >
        {aviso.accion} →
      </Link>
    </div>
  );
}
