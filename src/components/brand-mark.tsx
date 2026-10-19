import type { Branding } from "@/lib/branding";
import {
  BRAND_CYAN,
  BRAND_CYAN_ON_TILE,
  BRAND_MARK_BODY,
  BRAND_MARK_STROKE,
  BRAND_MARK_TAIL,
  isVoceroName,
} from "@/lib/brand";
import { faviconHref, faviconInitial } from "@/lib/favicon";
import { cn } from "@/lib/utils";

/**
 * O que a marca precisa para se desenhar: o nome, o acento e se há
 * logo enviado (o acento entra na URL versionada do ícone gerado).
 */
export type BrandingMark = Pick<Branding, "name" | "accent" | "favicon">;

/**
 * O traço da marca: o "v" caligráfico com remate ciano do vocerocrm.com.
 * O corpo herda `currentColor`; pinte-o com `text-brand` (ou branco sobre o
 * mosaico) e o remate continua ciano.
 */
export function BrandMark({
  className,
  cyan = BRAND_CYAN,
}: {
  className?: string;
  cyan?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        d={BRAND_MARK_BODY}
        stroke="currentColor"
        strokeWidth={BRAND_MARK_STROKE}
        strokeLinecap="round"
        fill="none"
      />
      <path
        d={BRAND_MARK_TAIL}
        stroke={cyan}
        strokeWidth={BRAND_MARK_STROKE}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * Mosaico quadrado com degradê do acento: é o favicon em tamanho grande. Com um
 * logo enviado leva o logo (o MESMO arquivo e a MESMA URL versionada da
 * aba, assim o que é enviado em Ajustes → Marca aparece nos dois lugares);
 * sem ele, o "v" do Vocero ou a inicial do nome white-label.
 */
export function BrandTile({
  branding,
  className,
}: {
  branding: BrandingMark;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "brand-tile flex shrink-0 items-center justify-center overflow-hidden text-brand-fg",
        className
      )}
      aria-hidden
    >
      {branding.favicon ? (
        // Sem next/image de propósito: é um arquivo de uma rota própria, já
        // pequeno; passá-lo pelo otimizador seria trabalho sem economia.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={faviconHref(branding)}
          alt=""
          className="h-full w-full object-contain"
        />
      ) : isVoceroName(branding.name) ? (
        <BrandMark className="h-[64%] w-[64%]" cyan={BRAND_CYAN_ON_TILE} />
      ) : (
        <span className="font-bold leading-none">{faviconInitial(branding.name)}</span>
      )}
    </span>
  );
}

const WORDMARK_SIZE = {
  md: "text-[21px]",
  lg: "text-[30px]",
} as const;

const MARK_SIZE = {
  md: "h-[24px] w-[24px]",
  lg: "h-[34px] w-[34px]",
} as const;

const TILE_SIZE = {
  md: "h-[30px] w-[30px] rounded-[9px] text-[15px]",
  lg: "h-[44px] w-[44px] rounded-[13px] text-[22px]",
} as const;

/**
 * A marca completa, como no cabeçalho da landing: traço + wordmark
 * "vocero" em minúsculas e bem justo. Uma instância renomeada vê no
 * lugar o mosaico com a inicial e o seu nome (white-label). Com logo enviado
 * vence o logo, chame-se como se chamar: quem envia um arquivo quer vê-lo.
 */
export function BrandLogo({
  branding,
  size = "md",
  className,
}: {
  branding: BrandingMark;
  size?: keyof typeof WORDMARK_SIZE;
  className?: string;
}) {
  if (isVoceroName(branding.name) && !branding.favicon) {
    return (
      <span className={cn("flex items-center gap-2 text-foreground", className)}>
        <BrandMark className={cn("shrink-0 text-brand", MARK_SIZE[size])} />
        <span
          className={cn(
            "font-[800] leading-none tracking-[-0.045em]",
            WORDMARK_SIZE[size]
          )}
        >
          vocero
        </span>
      </span>
    );
  }
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandTile branding={branding} className={TILE_SIZE[size]} />
      <span
        className={cn(
          "truncate font-[750] leading-none tracking-tight",
          size === "lg" ? "text-[26px]" : "text-[17px]"
        )}
      >
        {branding.name}
      </span>
    </span>
  );
}
