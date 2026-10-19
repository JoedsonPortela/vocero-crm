"use client";

import { cn } from "@/lib/utils";

/**
 * O interruptor do CRM: o do Agente (Encendido/Apagado) e o de «IA nesta
 * conversa» são ESTE componente. Antes eram duas cópias feitas à mão e
 * divergiram duas vezes, ambas no #53: primeiro o botão perdeu a sombra,
 * depois o do Agente saiu da pista. `tests/unit/switch.test.ts`
 * impede que outra cópia volte a aparecer.
 *
 * Por que `inline-flex` e não um botão `absolute`: um `<button>` centraliza o
 * seu conteúdo por padrão, então um filho absoluto sem `left` começa do
 * CENTRO da pista e, ao se deslocar, fica meio para fora. Com flex o botão
 * parte da borda interna esquerda (`px-0.5`) e se desloca exatamente a
 * largura que sobra à pista.
 */

const SIZES = {
  /** Cabeçalhos: a pista de 44 px que o Agente já usava. */
  md: { track: "h-6 w-11 px-0.5", knob: "h-5 w-5", on: "translate-x-5" },
  /** Painéis compactos: a de 36 px do painel de contato. */
  sm: { track: "h-5 w-9 px-0.5", knob: "h-4 w-4", on: "translate-x-4" },
} as const;

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  size = "md",
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Nome acessível: o interruptor não leva texto próprio. */
  label: string;
  disabled?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-colors",
        // O anel de `ui/button`: o acento sólido, separado da pista
        // (ligada já é da cor do acento). O suave (`ring-brand-soft`)
        // fica a ~1,3:1 do fundo e aparecia menos que o do navegador.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-40",
        s.track,
        checked ? "bg-brand" : "bg-border-strong",
        className
      )}
    >
      {/* `shadow-sm` não é enfeite: o botão é `--knob` (branco) e sobre o
          acento se perdia sem ele. */}
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-knob shadow-sm transition-transform",
          s.knob,
          checked ? s.on : "translate-x-0"
        )}
      />
    </button>
  );
}
