import { IconTile as UiIconTile } from "@ui/atoms/icon-tile";
import type { Tone } from "@ui/atoms/pill";
import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";

export type IconTileSize = "sm" | "md" | "lg";

const ICON: Record<IconTileSize, string> = {
  sm: "[&_svg]:size-4",
  md: "[&_svg]:size-4",
  lg: "[&_svg]:size-[18px]",
};

export function IconTile({
  children,
  size = "md",
  outline = false,
  tone,
  className,
}: {
  children: ReactNode;
  size?: IconTileSize;
  outline?: boolean;
  tone?: Tone;
  className?: string;
}) {
  return (
    <UiIconTile
      size={size}
      variant={outline ? "outline" : "muted"}
      tone={tone}
      className={cn(ICON[size], className)}
    >
      <span data-slot="icon-tile" className="contents">
        {children}
      </span>
    </UiIconTile>
  );
}
