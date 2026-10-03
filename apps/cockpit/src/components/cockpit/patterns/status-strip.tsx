import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ContextHelp } from "./context-help";

export type StatusTone = "ok" | "warn" | "error";

const DOT: Record<StatusTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
};

/**
 * A record's state in one line (P3), detail pages only: dot · line · (?) ·
 * one action. Only the top state gets the action (D15); lower states go into
 * `more`.
 */
export function StatusStrip({
  tone,
  line,
  help,
  more,
  action,
  testId,
}: {
  tone: StatusTone;
  line: ReactNode;
  /** The long explanation of the line, behind (?). */
  help?: ReactNode;
  /** The lower states, e.g. "+1 weiteres". */
  more?: ReactNode;
  /** Never more than one. */
  action?: ReactNode;
  testId?: string;
}) {
  const id = testId ?? "status-strip";
  return (
    <div
      data-slot="status-strip"
      data-tone={tone}
      data-testid={testId}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/40",
        tone === "warn" && "border-amber-500/40",
      )}
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      <span className="min-w-0 flex-1" data-slot="status-strip-line">
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
      {action ? <span className="ml-auto flex items-center">{action}</span> : null}
    </div>
  );
}
