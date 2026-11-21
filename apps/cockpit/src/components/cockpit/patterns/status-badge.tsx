import { Badge } from "@ui/atoms/badge";
import { cn } from "@ui/lib/utils";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

export type BadgeTone = "ok" | "warn" | "error" | "neutral";

const TONES: Partial<Record<string, BadgeTone>> = {
  ok: "ok",
  success: "ok",
  completed: "ok",
  succeeded: "ok",
  enabled: "ok",
  active: "ok",
  approved: "ok",
  applied: "ok",
  ready: "ok",
  clean: "ok",
  committed: "ok",
  valid: "ok",
  verified: "ok",
  failing: "error",
  stopped: "error",
  repair_required: "warn",
  waiting_approval: "warn",
  waiting_connector: "warn",
  failed: "error",
  error: "error",
  expired: "error",
  needs_reauth: "error",
  rejected: "error",
  denied: "error",
  timed_out: "error",
  timeout: "error",
  aborted: "error",
  infected: "error",
  critical: "error",
  unreadable: "error",
  pending: "warn",
  running: "warn",
  queued: "warn",
  waiting_budget: "warn",
  processing: "warn",
  uploading: "warn",
  scanning: "warn",
  degraded: "warn",
  needs_attention: "warn",
  needs_update: "warn",
  expiring: "warn",
  awaiting_input: "warn",
  proposed: "warn",
  warn: "warn",
};

export function statusTone(state: string): BadgeTone {
  return TONES[state.toLowerCase()] ?? "neutral";
}

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: "border-success/40 bg-success/10 text-success-ink",
  warn: "border-warning/50 bg-warning/10 text-warning-ink",
  error: "border-destructive/40 bg-destructive/10 text-destructive-ink",
  neutral: "border-border bg-secondary text-muted-foreground",
};

export function StatusBadge({
  state,
  label,
  testId,
  wrap = false,
}: {
  state: string;
  label?: string;
  testId?: string;
  wrap?: boolean;
}) {
  const { t } = useI18n();
  const tone = statusTone(state);
  const text = label ?? statusLabel(t, state);
  return (
    <Badge
      dot
      variant="outline"
      data-testid={testId}
      data-state={state}
      data-tone={tone}
      aria-label={text}
      className={cn(
        "h-6 min-w-0 max-w-full gap-1.5 px-2",
        wrap && "h-auto whitespace-normal text-left",
        TONE_CLASS[tone],
      )}
      title={text}
    >
      <span className={cn("min-w-0", wrap ? "break-words" : "truncate")}>{text}</span>
    </Badge>
  );
}
