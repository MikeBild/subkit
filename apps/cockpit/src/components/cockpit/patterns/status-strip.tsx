import type { ReactNode } from "react";
import { useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { type ActionSpec, renderAction } from "./action-button";
import { ContextHelp } from "./context-help";
import { Skeleton } from "./skeleton";

export type StatusTone = "ok" | "warn" | "error";

const DOT: Record<StatusTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
};

const STRIP =
  "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors duration-(--sk-dur-base) ease-(--sk-ease-standard)";

/**
 * A record's state in one line (P3), detail pages only: dot · line · (?) ·
 * one action. Only the top state gets the action (D15); lower states go into
 * `more`. A change of tone eases the border and the dot rather than jumping.
 */
export function StatusStrip({
  tone,
  line,
  help,
  more,
  action,
  loading,
  testId,
}: {
  tone: StatusTone;
  line: ReactNode;
  /** The long explanation of the line, behind (?). */
  help?: ReactNode;
  /** The lower states, e.g. "+1 weiteres". */
  more?: ReactNode;
  /** Never more than one: an element, or an `ActionSpec`. */
  action?: ReactNode | ActionSpec;
  /** The state is still loading: dot, one line and a button placeholder at the final size. */
  loading?: boolean;
  testId?: string;
}) {
  const id = testId ?? "status-strip";
  const phase = useLoadingPhase(Boolean(loading));
  if (phase !== "content")
    return (
      <div
        data-slot="status-strip"
        data-testid={testId}
        data-loading-phase={phase}
        role="status"
        aria-busy="true"
        className={cn(STRIP, phase === "reserve" ? "invisible" : "sk-fade-in")}
      >
        <Skeleton className="size-2 rounded-full" />
        <Skeleton className="h-4 w-2/3 max-w-sm" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
    );
  return (
    <div
      data-slot="status-strip"
      data-tone={tone}
      data-testid={testId}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        STRIP,
        tone === "error" && "border-destructive/40",
        tone === "warn" && "border-amber-500/40",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full transition-colors duration-(--sk-dur-base)",
          DOT[tone],
        )}
      />
      {/* The line keeps a readable width; on a phone the action wraps below it
          at full width instead of squeezing the line to a word per row. */}
      <span className="min-w-0 flex-1 basis-48" data-slot="status-strip-line">
        {line}
      </span>
      {help ? (
        <ContextHelp label={typeof line === "string" ? line : id} testId={`${id}-help`}>
          {help}
        </ContextHelp>
      ) : null}
      {more ? (
        <span className="text-xs text-muted-foreground" data-slot="status-strip-more">
          {more}
        </span>
      ) : null}
      {action ? (
        <span
          className="ml-auto flex items-center max-sm:basis-full max-sm:*:flex-1"
          data-slot="status-strip-action"
        >
          {renderAction(action)}
        </span>
      ) : null}
    </div>
  );
}
