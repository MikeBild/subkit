import type { ReactNode } from "react";
import { useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { ContextHelp } from "./context-help";
import { Skeleton } from "./skeleton";

const LINE = "flex flex-wrap items-center gap-2 text-sm text-muted-foreground";

/**
 * The first element of every tab (P5): one muted sentence, its (?) and, on the
 * right, the control that chooses what the tab shows (a SegmentedControl).
 */
export function SummaryLine({
  text,
  help,
  aside,
  loading,
  testId,
}: {
  text: ReactNode;
  help?: ReactNode;
  aside?: ReactNode;
  /** The sentence is still loading: one bar at the line's height. */
  loading?: boolean;
  testId?: string;
}) {
  const id = testId ?? "summary-line";
  const phase = useLoadingPhase(Boolean(loading));
  if (phase !== "content")
    return (
      <div
        data-slot="summary-line"
        data-testid={testId}
        data-loading-phase={phase}
        role="status"
        aria-busy="true"
        className={cn(LINE, phase === "reserve" ? "invisible" : "sk-fade-in")}
      >
        <span className="flex h-5 w-72 max-w-full items-center">
          <Skeleton className="h-4 w-full" />
        </span>
        {aside ? <span className="ml-auto flex items-center gap-2">{aside}</span> : null}
      </div>
    );
  return (
    <div data-slot="summary-line" data-testid={testId} className={LINE}>
      <span className="min-w-0" data-slot="summary-line-text">
        {text}
      </span>
      {help ? (
        <ContextHelp label={typeof text === "string" ? text : id} testId={`${id}-help`}>
          {help}
        </ContextHelp>
      ) : null}
      {aside ? <span className="ml-auto flex items-center gap-2">{aside}</span> : null}
    </div>
  );
}
