import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";

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
  failed: "error",
  error: "error",
  expired: "error",
  needs_reauth: "error",
  rejected: "error",
  denied: "warn",
  timed_out: "error",
  timeout: "error",
  aborted: "error",
  infected: "error",
  critical: "error",
  unreadable: "error",
  pending: "warn",
  running: "warn",
  queued: "warn",
  processing: "warn",
  uploading: "warn",
  scanning: "warn",
  degraded: "warn",
  needs_attention: "warn",
  needs_update: "warn",
  expiring: "warn",
  awaiting_input: "warn",
  proposed: "warn",
  invited: "warn",
  warn: "warn",
};

export function statusTone(state: string): BadgeTone {
  return TONES[state.toLowerCase()] ?? "neutral";
}

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-destructive",
  neutral: "text-muted-foreground",
};

export function StatusBadge({
  state,
  label,
  testId,
}: {
  state: string;
  label?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const tone = statusTone(state);
  return (
    <Badge
      dot
      variant="outline"
      data-testid={testId}
      data-state={state}
      data-tone={tone}
      className={cn(TONE_CLASS[tone])}
    >
      {label ?? statusLabel(t, state)}
    </Badge>
  );
}
