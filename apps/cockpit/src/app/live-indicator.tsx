import type { ReactNode } from "react";
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

export function LiveStatusRow({ status, actions }: { status: LiveStatus; actions?: ReactNode }) {
  return (
    <div
      className="flex min-h-8 items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-1"
      data-slot="footer-status"
    >
      <LiveIndicator status={status} />
      <div
        className="flex shrink-0 items-center gap-1 group-data-[collapsible=icon]:flex-col"
        data-slot="footer-status-actions"
      >
        {actions}
      </div>
    </div>
  );
}
