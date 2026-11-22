import { Button } from "@ui/atoms/button";
import { Skeleton } from "@ui/atoms/skeleton";
import { cn } from "@ui/lib/utils";
import { EmptyState } from "@ui/molecules/empty-state";
import { ErrorNotice, ErrorState } from "@ui/molecules/error-notice";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
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
        data-sk-slot="data-state"
        data-sk-state="loading"
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
  return <EmptyState inline title={line} action={shown} testId={testId} className={className} />;
}
