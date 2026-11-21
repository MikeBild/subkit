import { ErrorNotice, ErrorState } from "@ui/components/proto/ErrorNotice";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { useErrorNotice, usePageFailure } from "./use-error-detail";

export type DataStateKind = "loading" | "empty" | "error";

export const LOADING_ROWS = 3;

export function DataState({
  state,
  line,
  action,
  onRetry,
  error,
  testId,
  className,
  scope = "section",
}: {
  state: DataStateKind;
  scope?: "section" | "page";
  line?: string;
  action?: ReactNode;
  onRetry?: () => void;
  error?: unknown;
  testId?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const notice = useErrorNotice({ error });
  const page = usePageFailure(
    state === "error" && scope === "page" && onRetry
      ? {
          onRetry,
          error,
          testId: `${testId ?? "data-state"}-error`,
          retryTestId: `${testId ?? "data-state"}-retry`,
        }
      : null,
  );
  if (page) return <ErrorState {...page} heading="h2" />;
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
      <Button
        size="sm"
        onClick={onRetry}
        data-slot="data-state-retry"
        data-testid={`${testId ?? "data-state"}-retry`}
      >
        {t("pattern.retry")}
      </Button>
    ) : null);
  if (state === "error")
    return (
      <ErrorNotice
        {...notice}
        title={line ?? t("error.loadFailed")}
        titleSlot="data-state-line"
        testId={testId ?? "data-state"}
        className={className}
        actions={shown}
      />
    );
  return (
    <div
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-2.5 text-left",
        className,
      )}
      data-testid={testId}
      data-state={state}
      data-family-slot="data-state"
      data-family-state={state}
    >
      {line ? (
        <p className="text-sm text-muted-foreground" data-slot="data-state-line">
          {line}
        </p>
      ) : null}
      {shown}
    </div>
  );
}
