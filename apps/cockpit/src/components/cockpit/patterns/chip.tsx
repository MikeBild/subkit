import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ChipSize = "sm" | "md";

const SIZE: Record<ChipSize, string> = {
  sm: "gap-1 px-1.5 py-0.5 text-xs [&_svg]:size-3",
  md: "gap-1.5 px-2 py-1 text-sm [&_svg]:size-3.5",
};

export function chipClass(size: ChipSize = "sm"): string {
  return cn("inline-flex shrink-0 items-center rounded-md border text-foreground", SIZE[size]);
}

export function Chip({
  size = "sm",
  className,
  testId,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { size?: ChipSize; testId?: string }) {
  return (
    <span
      data-slot="chip"
      data-testid={testId}
      className={cn(chipClass(size), className)}
      {...props}
    />
  );
}
