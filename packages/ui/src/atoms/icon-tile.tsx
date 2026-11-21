import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Tone } from "./pill";

const tileSize = { sm: "size-7", md: "size-8", lg: "size-9" } as const;
const tileIcon = { sm: "size-4", md: "size-4", lg: "size-[18px]" } as const;
export function IconTile({
  icon: I,
  children,
  size = "md",
  variant = "muted",
  tone,
  className,
}: {
  icon?: LucideIcon;
  children?: ReactNode;
  size?: keyof typeof tileSize;
  variant?: "muted" | "outline";
  tone?: Tone | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md",
        tileSize[size],
        variant === "muted" ? "bg-muted text-foreground" : "border bg-background text-foreground",
        tone && toneTile[tone],
        className,
      )}
    >
      {I ? <I className={tileIcon[size]} /> : children}
    </span>
  );
}
const toneTile: Record<Tone, string> = {
  success: "bg-success/10 text-success-ink",
  warning: "bg-warning/10 text-warning-ink",
  danger: "bg-destructive/10 text-destructive-ink",
  info: "bg-accent/10 text-info-ink",
  neutral: "",
};
