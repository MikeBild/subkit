import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ActivityLine({
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex min-h-6 flex-wrap items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
      role="status"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {children}
    </div>
  );
}
