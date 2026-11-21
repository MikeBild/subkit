import { Skeleton } from "@ui/atoms/skeleton";
import { useLoadingPhase } from "@ui/lib/loading-phase";
import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";
import { type ActionSpec, renderAction } from "./action-button";
import { ContextHelp } from "./context-help";

export type StatusTone = "ok" | "info" | "warn" | "error";

export const STATUS_DOT: Record<StatusTone, string> = {
  ok: "bg-emerald-500",
  info: "bg-blue-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
};

const STRIP =
  "flex min-h-12.5 flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors duration-(--sk-dur-base) ease-(--sk-ease-standard)";

export function StatusStrip({
  tone,
  line,
  help,
  more,
  aside,
  action,
  loading,
  testId,
}: {
  tone: StatusTone;
  line: ReactNode;
  help?: ReactNode;
  more?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode | ActionSpec;
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
      className={STRIP}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full transition-colors duration-(--sk-dur-base)",
          STATUS_DOT[tone],
        )}
      />
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
      {aside ? (
        <span
          className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden"
          data-slot="status-strip-aside"
        >
          {aside}
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
