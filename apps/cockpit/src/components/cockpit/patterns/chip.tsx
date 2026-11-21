import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ChipSize = "sm" | "md";

const SIZE: Record<ChipSize, string> = {
  sm: "h-6 gap-1.5 px-2 text-xs [&_svg]:size-3",
  md: "h-7 gap-1.5 px-2.5 text-sm [&_svg]:size-3.5",
};

export function chipClass(size: ChipSize = "sm"): string {
  return cn("inline-flex shrink-0 items-center rounded-full border text-foreground", SIZE[size]);
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
