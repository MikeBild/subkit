import { LevelMeter } from "@ui/atoms/level-meter";
import { Spinner } from "@ui/atoms/spinner";
import { StatusDot } from "@ui/atoms/status-dot";
import { cn } from "@ui/lib/utils";

export function RecordingIndicator({
  phase,
  label,
  elapsed,
  level = 0,
  className,
}: {
  phase: "recording" | "working";
  label: string;
  elapsed?: string;
  level?: number;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      {phase === "recording" ? (
        <StatusDot tone="danger" pulse />
      ) : (
        <Spinner role="presentation" aria-hidden className="size-3" />
      )}
      <span>{label}</span>
      {phase === "recording" && elapsed ? <span className="tabular-nums">{elapsed}</span> : null}
      {phase === "recording" ? <LevelMeter level={level} className="text-destructive" /> : null}
    </span>
  );
}
