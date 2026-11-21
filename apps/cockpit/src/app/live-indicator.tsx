import { Pill, type Tone } from "@ui/atoms/pill";
import { cn } from "@ui/lib/utils";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { LiveStatus } from "./live-events";

export const LIVE_TONE: Record<LiveStatus, Tone> = {
  live: "success",
  connecting: "neutral",
  reconnecting: "warning",
  offline: "warning",
};

export const LIVE_LABEL = {
  live: "platform.live.live",
  connecting: "platform.live.connecting",
  reconnecting: "platform.live.reconnecting",
  offline: "platform.live.offline",
} as const satisfies Record<LiveStatus, TranslationKey>;

export function LiveIndicator({ status }: { status: LiveStatus }) {
  const { t } = useI18n();
  const label = t(LIVE_LABEL[status]);
  return (
    <span
      role="status"
      title={label}
      data-testid="cockpit-live-indicator"
      data-live-status={status}
      className="inline-flex min-w-0"
    >
      <Pill tone={LIVE_TONE[status]} className="min-w-0">
        <span className="truncate" data-slot="live-word">
          {label}
        </span>
      </Pill>
    </span>
  );
}

export function AttentionDot({ stopped, className }: { stopped: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="attention-new-dot"
      data-attention-stopped={String(stopped)}
      className={cn(
        "pointer-events-none absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
        stopped ? "bg-destructive" : "bg-primary",
        className,
      )}
    />
  );
}
