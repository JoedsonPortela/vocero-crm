import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Botões em pílula, como os `.btn` do vocerocrm.com: semibold, justos e
 * com um leve levantamento ao passar o cursor. O principal leva o acento
 * white-label; o `outline` é o fantasma da landing (borda fina que escurece ao passar).
 *
 * Sem modificadores de opacidade (`bg-primary/90`): o Tailwind 3 não sabe
 * aplicá-los a uma cor `var(--x)` e descarta a regra em silêncio.
 */
// Exportado para desenhar um <Link> como botão (o guia inicial): um botão
// que navega é um link, e um link não pode ser um <button>.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-[-0.01em] transition-[color,background-color,border-color,transform,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:-translate-y-px hover:bg-brand-hover active:translate-y-0",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        outline:
          "border border-border-strong bg-transparent text-foreground hover:-translate-y-px hover:border-foreground active:translate-y-0",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:opacity-90",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
