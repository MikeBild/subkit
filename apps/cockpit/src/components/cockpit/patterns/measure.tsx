import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";

export type Measure = "label" | "name" | "excerpt";

const MEASURES: Record<Measure, string> = {
  label: "max-w-48",
  name: "max-w-80",
  excerpt: "min-w-48 max-w-72",
};

export function measureClass(measure: Measure): string {
  return MEASURES[measure];
}

export function Measured({
  measure,
  className,
  children,
}: {
  measure: Measure;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("block min-w-0 truncate", MEASURES[measure], className)}>{children}</span>
  );
}
