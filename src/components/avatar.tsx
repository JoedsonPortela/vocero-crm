import { avatarColor, cn, initials } from "@/lib/utils";

/** Avatar de contato: iniciais sobre cor estável (FR-006). */
export function ContactAvatar({
  name,
  seed,
  size = "md",
}: {
  name: string;
  /** Semente da cor (id ou telefone): estável para o mesmo contato. */
  seed: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizes = {
    sm: "h-7 w-7 text-[10px]",
    md: "h-9 w-9 text-xs",
    lg: "h-12 w-12 text-sm",
  } as const;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        sizes[size],
        avatarColor(seed)
      )}
      aria-hidden
    >
      {initials(name)}
    </div>
  );
}
