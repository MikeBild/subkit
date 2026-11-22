import { IconTile } from "@ui/atoms/icon-tile";
import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  text,
  action,
  inline = false,
  testId,
  className,
}: {
  icon?: LucideIcon | undefined;
  title?: string | undefined;
  text?: string | undefined;
  action?: ReactNode;
  inline?: boolean;
  testId?: string | undefined;
  className?: string | undefined;
}) {
  if (inline)
    return (
      <div
        className={cn(
          "flex min-h-11 flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-2.5 text-left",
          className,
        )}
        data-testid={testId}
        data-slot="empty-state"
        data-state="empty"
        data-sk-slot="data-state"
        data-sk-state="empty"
      >
        {title ? (
          <p className="text-sm text-muted-foreground" data-slot="data-state-line">
            {title}
          </p>
        ) : null}
        {action}
      </div>
    );
  return (
    <div
      data-testid={testId}
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <span className="flex size-16 items-center justify-center rounded-full bg-muted/60">
          <IconTile icon={icon} size="lg" variant="outline" />
        </span>
      ) : null}
      {title ? <p className="mt-4 font-semibold">{title}</p> : null}
      {text && <p className="mt-1 text-sm text-muted-foreground">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
