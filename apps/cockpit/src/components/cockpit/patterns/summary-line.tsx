import { Fragment, type ReactNode } from "react";
import { useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { ContextHelp } from "./context-help";
import { Skeleton } from "./skeleton";

const LINE = "flex min-h-5.5 flex-wrap items-center gap-2 text-sm text-muted-foreground";
const SPLIT =
  "grid gap-2 text-sm text-muted-foreground @4xl:grid-cols-[minmax(0,1fr)_auto] @4xl:items-center";
const SPLIT_TEXT = "flex min-h-7 min-w-0 items-center gap-2 @4xl:min-h-10";
const SPLIT_ASIDE = "flex min-w-0 max-w-full items-center justify-self-end gap-2";

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
  const busy = phase !== "content";
  const lead = busy ? (
    <span className="flex h-5 w-72 max-w-full items-center">
      <Skeleton className="h-4 w-full" />
    </span>
  ) : (
    <>
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
    </>
  );
  const state = busy
    ? ({ "data-loading-phase": phase, role: "status", "aria-busy": true } as const)
    : {};
  const hidden = busy ? (phase === "reserve" ? "invisible" : "sk-fade-in") : null;
  if (aside)
    return (
      <div className="@container" data-slot="summary-line" data-testid={testId} {...state}>
        <div className={SPLIT} data-slot="summary-line-split">
          <span className={cn(SPLIT_TEXT, hidden)}>{lead}</span>
          <span className={SPLIT_ASIDE} data-slot="summary-line-aside">
            {aside}
          </span>
        </div>
      </div>
    );
  return (
    <div
      data-slot="summary-line"
      data-testid={testId}
      className={cn(LINE, help ? "min-h-7" : null, hidden)}
      {...state}
    >
      {lead}
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
