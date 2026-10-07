import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import type { LiveStatus } from "./live-events";

const LIVE_DOT: Record<LiveStatus, string> = {
  live: "bg-success",
  connecting: "bg-muted-foreground/40",
  reconnecting: "bg-warning animate-pulse motion-reduce:animate-none",
  offline: "bg-muted-foreground/40",
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
      className="flex h-4 min-w-0 items-center gap-1.5 px-2 text-xs leading-4 text-muted-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", LIVE_DOT[status])} />
      <span className="truncate group-data-[collapsible=icon]:sr-only" data-slot="live-word">
        {label}
      </span>
    </span>
  );
}
