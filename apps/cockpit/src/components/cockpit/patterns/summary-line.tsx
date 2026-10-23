import { Fragment, type ReactNode } from "react";
import { useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { ContextHelp } from "./context-help";
import { Skeleton } from "./skeleton";

const LINE = "flex flex-wrap items-center gap-2 text-sm text-muted-foreground";

export function SummaryLine({
  text,
  help,
  helpLabel,
  aside,
  loading,
  testId,
}: {
  text: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  aside?: ReactNode;
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
        <ContextHelp
          label={helpLabel ?? (typeof text === "string" ? text : id)}
          testId={`${id}-help`}
        >
          {help}
        </ContextHelp>
      ) : null}
      {aside ? (
        <span className="ml-auto flex min-w-0 max-w-full items-center gap-2">{aside}</span>
      ) : null}
    </div>
  );
}

export function SummaryParts({ parts }: { parts: readonly ReactNode[] }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false);
  return (
    <span
      className="flex flex-col items-start gap-0.5 text-left sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5"
      data-slot="summary-parts"
    >
      {shown.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden="true" className="hidden sm:inline" data-slot="summary-separator">
              ·
            </span>
          ) : null}
          <span className="min-w-0" data-slot="summary-part">
            {part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
