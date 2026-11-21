import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
