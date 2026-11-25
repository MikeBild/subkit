import { Badge } from "@ui/atoms/badge";
import { cn } from "@ui/lib/utils";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { type BadgeTone, statusTone } from "@/lib/status-tone";

export { type BadgeTone, statusTone };

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: "border-success/40 bg-success/10 text-success-ink",
  warn: "border-warning/50 bg-warning/10 text-warning-ink",
  error: "border-destructive/40 bg-destructive/10 text-destructive-ink",
  neutral: "border-border bg-secondary text-muted-foreground",
};

export function StatusBadge({
  state,
  label,
  tone: toneOverride,
  testId,
  wrap = false,
}: {
  state: string;
  label?: string;
  /** Overrides the tone the shared status table gives `state`, for a feature's own states. */
  tone?: BadgeTone;
  testId?: string;
  wrap?: boolean;
}) {
  const { t } = useI18n();
  const tone = toneOverride ?? statusTone(state);
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
