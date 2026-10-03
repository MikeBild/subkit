import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
import { useArrived, useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";

/**
 * The one skeleton look: a muted block with a slow, subtle shimmer (still
 * under reduced motion). Every loading pattern draws its final shape out of
 * these, at the final size, so nothing moves when the data arrives.
 */
export function Skeleton({ className, testId }: { className?: string; testId?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      data-testid={testId}
      className={cn("sk-skeleton block rounded-md", className)}
    />
  );
}

/**
 * A pattern's loading frame. While loading it renders the pattern's own
 * skeleton — invisible for the first moments, so a fast answer arrives
 * without a flash, then shown and held briefly so it never flickers — and the
 * content fades in where the skeleton stood. The frame is one block element.
 */
export function Loadable({
  loading,
  skeleton,
  children,
  className,
  testId,
}: {
  loading: boolean | undefined;
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const phase = useLoadingPhase(Boolean(loading));
  const arrived = useArrived(phase);
  if (phase === "content")
    return (
      <div className={cn(arrived && "sk-fade-in", className)} data-testid={testId}>
        {children}
      </div>
    );
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="loading"
      data-loading-phase={phase}
      data-testid={testId}
      className={cn(phase === "reserve" ? "invisible" : "sk-fade-in", className)}
    >
      <span className="sr-only">{t("platform.inProgress")}</span>
      {skeleton}
    </div>
  );
}

/** A KPI tile's shape: the label, the figure, the trend line. */
export function TileSkeleton({ testId }: { testId?: string }) {
  return (
    <div
      data-slot="tile-skeleton"
      data-testid={testId}
      className="flex flex-col gap-2 rounded-lg border p-4"
    >
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="h-7 w-16" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

/** Rows of a list or a tab panel: `count` bars, each one table row high. */
export function RowsSkeleton({ count = 3, testId }: { count?: number; testId?: string }) {
  return (
    <div data-slot="rows-skeleton" data-testid={testId} className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-11 items-center gap-4 border-b last:border-b-0">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-4 w-1/5" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
