import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IconButton } from "@/components/cockpit/icon-button";
import { InstallationNotificationControl } from "@/components/cockpit/installation-dialogs";
import { useSidebar } from "@/components/ui/sidebar";
import { FeedbackButton } from "@/features/feedback";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { useAttentionFresh } from "./attention-seen";
import { useLiveStatus } from "./live-events";
import { AttentionDot, LiveIndicator } from "./live-indicator";
import { useSession } from "./session";
import { SidePanelToggle } from "./side-panel";

export const CHAT_COLUMN = "w-full min-w-0 max-w-[80rem]";

export const ACCOUNT_TRIGGER =
  "h-auto min-h-12 items-center py-2 group-data-[collapsible=icon]:min-h-0";

export const SHELL_BAR = "flex h-14 shrink-0 items-center border-b";

export const BAR_TOGGLE = "aria-expanded:bg-transparent aria-expanded:hover:bg-secondary";

export type SidebarToggleIcon = "menu" | "collapse" | "expand";

export function sidebarToggleIcon(input: {
  mobile: boolean;
  expanded: boolean;
}): SidebarToggleIcon {
  if (input.mobile) return "menu";
  return input.expanded ? "collapse" : "expand";
}

const TOGGLE_ICON = {
  menu: Menu,
  collapse: PanelLeftClose,
  expand: PanelLeftOpen,
} as const;

export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const { isMobile, openMobile, state, toggleSidebar, triggerRef } = useSidebar();
  const Icon = TOGGLE_ICON[sidebarToggleIcon({ mobile: isMobile, expanded: state === "expanded" })];
  const label = t("nav.toggle");
  return (
    <IconButton
      label={label}
      size="icon"
      tooltip={`${label} (⌘B)`}
      className={cn(BAR_TOGGLE, className)}
      aria-expanded={isMobile ? openMobile : state === "expanded"}
      aria-keyshortcuts="Meta+B Control+B"
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      data-testid="sidebar-trigger"
      onClick={(event) => {
        triggerRef.current = event.currentTarget;
        toggleSidebar();
      }}
    >
      <Icon />
    </IconButton>
  );
}

function NavigationToggle() {
  const session = useSession();
  const fresh = useAttentionFresh(session);
  const { isMobile } = useSidebar();
  if (!isMobile || !fresh) return <SidebarToggle className="-ml-3 shrink-0" />;
  return (
    <span className="relative -ml-3 inline-flex shrink-0" data-testid="sidebar-trigger-attention">
      <SidebarToggle className="shrink-0" />
      <AttentionDot stopped={fresh.stopped} className="top-1.5 right-1.5" />
    </span>
  );
}

export function ShellHeader() {
  const { status } = useLiveStatus();
  return (
    <header
      className={`${SHELL_BAR} gap-2 px-4 sm:px-8`}
      data-slot="shell-header"
      data-testid="cockpit-header"
    >
      <NavigationToggle />
      <LiveIndicator status={status} />
      <div className="ml-auto flex shrink-0 items-center gap-2" data-slot="shell-header-actions">
        <InstallationNotificationControl />
        <FeedbackButton />
        <SidePanelToggle className={cn(BAR_TOGGLE, "-mr-3 shrink-0")} />
      </div>
    </header>
  );
}
