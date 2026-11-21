import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";

export function PageTitle({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <h1
      data-testid={testId}
      title={typeof children === "string" ? children : undefined}
      className={cn("min-w-0 truncate text-2xl font-semibold", className)}
    >
      {children}
    </h1>
  );
}
