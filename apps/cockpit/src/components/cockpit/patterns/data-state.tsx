import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export type DataStateKind = "loading" | "empty" | "error";

/** The number of placeholder rows a loading list shows, each one table row high. */
export const LOADING_ROWS = 3;

/**
 * The one empty, loading and error UI (P12): one line and one action,
 * left-aligned in the content column. No illustration, no second paragraph —
 * whatever else there is to say goes behind a (?) on the line that needs it.
 */
export function DataState({
  state,
  line,
  action,
  onRetry,
  testId,
  className,
}: {
  state: DataStateKind;
  /** The one line. Loading needs none; the skeleton rows say it. */
  line?: string;
  /** The one action. An error without one offers "Erneut versuchen" when it can retry. */
  action?: ReactNode;
  onRetry?: () => void;
  testId?: string;
  className?: string;
}) {
  const { t } = useI18n();
  if (state === "loading")
    return (
      <div
        role="status"
        aria-busy="true"
        className={cn("flex flex-col gap-1", className)}
        data-testid={testId}
        data-state="loading"
        data-family-slot="data-state"
        data-family-state="loading"
      >
        {line ? <span className="sr-only">{line}</span> : null}
        {Array.from({ length: LOADING_ROWS }, (_, index) => (
          <Skeleton key={index} className="h-11 w-full" data-slot="data-state-row" />
        ))}
      </div>
    );
  const shown =
    action ??
    (state === "error" && onRetry ? (
      <Button variant="outline" size="sm" onClick={onRetry} data-slot="data-state-retry">
        {t("pattern.retry")}
      </Button>
    ) : null);
  return (
    <div
      role={state === "error" ? "alert" : undefined}
      className={cn("flex flex-wrap items-center gap-3 py-4 text-left", className)}
      data-testid={testId}
      data-state={state}
      data-family-slot="data-state"
      data-family-state={state}
    >
      {line ? (
        <p
          className={cn(
            "text-sm",
            state === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          data-slot="data-state-line"
        >
          {line}
        </p>
      ) : null}
      {shown}
    </div>
  );
}
