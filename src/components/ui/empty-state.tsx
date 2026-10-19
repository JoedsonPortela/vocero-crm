import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * #87 — Um único estado vazio para todas as telas: ícone num círculo
 * do acento, título, uma linha que diz o que vai acontecer aqui e, se houver algo
 * a fazer agora mesmo, o botão para fazê-lo.
 *
 * Centraliza no espaço que lhe derem (a Bandeja dá a coluna inteira; os
 * Modelos, um cartão pontilhado): o contêiner é definido por quem o usa via
 * `className`.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 p-6 text-center",
        className
      )}
    >
      <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand">
        <Icon className="h-6 w-6" strokeWidth={1.6} aria-hidden />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && (
        <p className="max-w-sm text-sm leading-relaxed text-text-3">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
