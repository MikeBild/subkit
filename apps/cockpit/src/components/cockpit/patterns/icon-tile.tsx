import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type IconTileSize = "sm" | "md" | "lg";

const SIZE: Record<IconTileSize, string> = {
  sm: "size-7 [&_svg]:size-4",
  md: "size-8 [&_svg]:size-4",
  lg: "size-9 [&_svg]:size-[18px]",
};

export function IconTile({
  children,
  size = "md",
  outline = false,
  className,
}: {
  children: ReactNode;
  size?: IconTileSize;
  outline?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="icon-tile"
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-md text-foreground",
        outline ? "border bg-background" : "bg-muted",
        SIZE[size],
        className,
      )}
    >
      {children}
    </span>
  );
}
