import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BookText,
  ChevronsUpDown,
  History,
  Languages,
  Loader2,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  Palette,
  Sun,
  UserRound,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { logout } from "@/api/client";
import { installationId } from "@/app/installation-context";
import {
  BrandingAppearance,
  BrandingAttribution,
  BrandingWordmark,
} from "@/components/cockpit/branding";
import {
  InstallationFollowupPrompt,
  InstallationNotificationControl,
} from "@/components/cockpit/installation-dialogs";
import { InstallationImportDialog } from "@/components/cockpit/installation-import-dialog";
import { ResponsiveWorkspace } from "@/components/cockpit/patterns/responsive-workspace";
import { ReleaseNotesDialog } from "@/components/cockpit/release-notes-dialog";
import { WorkspaceSwitcher } from "@/components/cockpit/workspace-switcher";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import type { TranslationKey } from "@/lib/i18n";
import { type LocalePreference, useI18n } from "@/lib/i18n-context";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { RunOverlays } from "@/pages/runs";
import { cockpitBasePath } from "./installation-context";
import { LiveEventsProvider, useLiveStatus } from "./live-events";
import { LiveIndicator } from "./live-indicator";
import {
  type NavigationItem,
  navigationItem,
  visibleAccountNavigation,
  visiblePrimaryNavigation,
} from "./navigation";
import { pageOf, useRouteEntrance } from "./route-entrance";
import { useSession } from "./session";
import {
  ACCOUNT_TRIGGER,
  CHAT_COLUMN,
  ShellHeaderProvider,
  SidebarToggle,
  triggerOwner,
  useShellHeaderState,
} from "./shell-header";
import { useAttention } from "./use-attention";
import { VersionNotice } from "./version-notice";

const THEMES: {
  value: Theme;
  label: TranslationKey;
  icon: LucideIcon;
}[] = [
  { value: "system", label: "account.theme.system", icon: Monitor },
  { value: "light", label: "account.theme.light", icon: Sun },
  { value: "dark", label: "account.theme.dark", icon: Moon },
];

const LANGUAGES: { value: LocalePreference; label: TranslationKey }[] = [
  { value: "auto", label: "account.language.auto" },
  { value: "en", label: "account.language.en" },
  { value: "de", label: "account.language.de" },
];

function initials(value: string): string {
  return (
    value
      .split(/[@\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "SK"
  );
}

function localizedRole(role: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (role === "admin") return t("role.admin");
  if (role === "member") return t("role.member");
  if (role === "enduser") return t("role.enduser");
  return role;
}

function PrimaryNavigationLink({
  item,
  label,
  active,
}: {
  item: NavigationItem;
  label: string;
  active: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton asChild tooltip={label} isActive={active}>
      <Link
        to={item.path}
        data-testid={item.path === "/" ? "nav-overview" : `nav-${item.path.slice(1)}`}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
        }}
      >
        <item.icon data-icon="inline-start" />
        <span>{label}</span>
      </Link>
    </SidebarMenuButton>
  );
}

export function AppShell() {
  const session = useSession();
  const { t } = useI18n();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const groups = visiblePrimaryNavigation(session.permissions);
  const active = navigationItem(pathname.slice(cockpitBasePath().length) || "/");
  const brandName = installationId()
    ? session.tenant.display_name
    : session.branding?.configured
      ? session.branding.display_name || session.tenant.display_name
      : t("app.name");

  return (
    <LiveEventsProvider>
      <BrandingAppearance />
      <SidebarProvider
        data-testid="cockpit-shell"
        data-cockpit-ui
        className="h-svh min-h-0 overflow-hidden"
      >
        <Sidebar
          collapsible="icon"
          mobileTitle={
            installationId() || session.branding?.configured ? brandName : t("app.cockpit")
          }
          mobileDescription={t("nav.mobileDescription")}
          mobileCloseLabel={t("common.close")}
          mobileCloseTestId="cockpit-sidebar-mobile-close"
          data-testid="cockpit-sidebar"
          data-cockpit-ui="product-sidebar"
        >
          <SidebarHeader data-testid="cockpit-sidebar-header">
            {!installationId() ? (
              <WorkspaceSwitcher attention={<AttentionCounter />} />
            ) : (
              <SidebarMenu>
                <SidebarMenuItem data-testid="cockpit-wordmark">
                  <SidebarMenuButton asChild size="lg" tooltip={brandName}>
                    <Link to="/" data-testid="cockpit-home-link">
                      <BrandingWordmark />
                      <AttentionCounter />
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarHeader>

          <SidebarContent data-testid="cockpit-navigation" key={pathname}>
            <nav aria-label={t("nav.label")}>
              {groups.map((group) => (
                <SidebarGroup key={group.id} data-testid={`nav-group-${group.id}`}>
                  {group.labelKey && <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item) => {
                        const label = t(item.labelKey);
                        return (
                          <SidebarMenuItem key={item.path}>
                            <PrimaryNavigationLink
                              item={item}
                              label={label}
                              active={active === item}
                            />
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </nav>
          </SidebarContent>

          <SidebarFooter
            data-testid="cockpit-sidebar-footer"
            className={cn(
              "gap-2",
              session.branding?.configured && "border-t border-sidebar-border",
            )}
          >
            <div
              className="flex min-h-8 items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-1"
              data-slot="footer-status"
            >
              <ShellLiveIndicator />
              <DesktopSidebarToggle />
            </div>
            <InstallationNotificationControl />
            <InstallationFollowupPrompt tenantName={session.tenant.display_name} />
            <SidebarMenu>
              <SidebarMenuItem>
                <AccountMenu />
              </SidebarMenuItem>
            </SidebarMenu>
            <BrandingAttribution />
          </SidebarFooter>
          <SidebarRail
            aria-label={t("nav.toggle")}
            title={t("nav.toggle")}
            data-testid="sidebar-rail"
          />
        </Sidebar>

        <SidebarInset className="min-h-0 min-w-0 overflow-hidden" data-testid="cockpit-content">
          <ShellContent />
        </SidebarInset>
        <Toaster richColors position="bottom-right" />
        <InstallationImportDialog />
        <VersionNotice />
      </SidebarProvider>
    </LiveEventsProvider>
  );
}

function ShellContent() {
  const { isMobile } = useSidebar();
  const page = useRouterState({
    select: (state) => pageOf(state.location.pathname),
  });
  const content = useRef<HTMLDivElement>(null);
  useRouteEntrance(content, page);
  const header = useShellHeaderState();
  const chat = header.chatHeaders > 0;
  const owner = triggerOwner({
    mobile: isMobile,
    chatHeader: chat,
    pageFrames: header.pageFrames,
  });
  return (
    <ShellHeaderProvider
      owner={owner}
      slot={header.slot}
      claimPageFrame={header.claimPageFrame}
      claimChatHeader={header.claimChatHeader}
    >
      {owner === "bar" &&
        (chat ? (
          <header
            className="scrollbar-thin shrink-0 overflow-hidden border-b px-4 py-2 sm:px-6 [scrollbar-gutter:stable]"
            data-testid="cockpit-header"
            data-cockpit-header="chat"
          >
            <div className={cn("flex min-h-8 items-start gap-2", CHAT_COLUMN)}>
              <SidebarToggle className="-ml-1 shrink-0" />
              <div ref={header.setSlot} className="min-w-0 flex-1" />
            </div>
          </header>
        ) : (
          <header
            className="flex h-12 shrink-0 items-center gap-3 border-b px-4 sm:px-6"
            data-testid="cockpit-header"
          >
            <SidebarToggle className="-ml-1" />
          </header>
        ))}
      <ResponsiveWorkspace>
        <div
          ref={content}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          data-testid="page-content"
        >
          <Outlet />
        </div>
        <RunOverlays />
      </ResponsiveWorkspace>
    </ShellHeaderProvider>
  );
}

function DesktopSidebarToggle() {
  const isMobile = useIsMobile();
  return isMobile ? null : <SidebarToggle className="shrink-0" />;
}

function AttentionCounter() {
  const session = useSession();
  const { query, badge } = useAttention(session.permissions);
  if (query.isError || badge === null || badge.count === 0) return null;
  return (
    <span
      className={cn(
        "ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-sidebar-accent px-1.5 text-[11px] font-medium tabular-nums group-data-[collapsible=icon]:hidden",
        badge.stopped && "text-destructive",
      )}
      data-testid="nav-overview-count"
      data-attention-stopped={String(badge.stopped)}
    >
      {badge.count}
    </span>
  );
}

function ShellLiveIndicator() {
  const { status } = useLiveStatus();
  return <LiveIndicator status={status} />;
}

function AccountMenu() {
  const session = useSession();
  const { t, preference, setPreference } = useI18n();
  const { theme, setTheme } = useTheme();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const [signingOut, setSigningOut] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const identity = session.principal.email || session.principal.role_name || t("common.member");
  const role = localizedRole(session.principal.role_name || "member", t);
  const accountNavigation = visibleAccountNavigation(session.permissions);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const current = pathname.slice(cockpitBasePath().length) || "/";
  const active = navigationItem(current);
  const docsActive = current === "/docs" || current.startsWith("/docs/");

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await logout();
      window.location.assign(cockpitBasePath());
    } catch {
      toast.error(t("account.signOutFailed"), {
        description: t("account.signOutFailedDescription"),
      });
      setSigningOut(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            className={ACCOUNT_TRIGGER}
            title={identity}
            data-testid="account-menu-trigger"
            tooltip={t("account.menu")}
          >
            <Avatar>
              <AvatarFallback>{initials(identity)}</AvatarFallback>
            </Avatar>
            <span className="grid min-w-0 flex-1 gap-0.5 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span
                className="font-medium whitespace-normal [overflow-wrap:anywhere]"
                data-testid="account-name"
              >
                {identity}
              </span>
              <span className="text-xs text-muted-foreground" data-testid="account-role">
                {role}
              </span>
            </span>
            <ChevronsUpDown
              data-icon="inline-end"
              className="ml-auto shrink-0 group-data-[collapsible=icon]:hidden"
            />
          </SidebarMenuButton>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side={isMobile ? "top" : "right"}
          align="end"
          className="w-64 max-h-[min(80vh,640px)] overflow-y-auto"
          data-testid="account-menu"
        >
          <DropdownMenuLabel data-testid="account-summary">
            <span className="block text-sm font-medium whitespace-normal text-foreground [overflow-wrap:anywhere]">
              {identity}
            </span>
            <span className="block truncate font-normal">{session.tenant.display_name}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {accountNavigation.map((item) => (
            <DropdownMenuItem
              key={item.path}
              asChild
              className={active === item ? "bg-accent text-accent-foreground" : undefined}
              data-testid={`account-nav-${item.path.slice(1)}`}
            >
              <Link
                to={item.path}
                data-testid={`account-link-${item.path.slice(1)}`}
                aria-current={active === item ? "page" : undefined}
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
              >
                <item.icon data-icon="inline-start" />
                {t(item.labelKey)}
              </Link>
            </DropdownMenuItem>
          ))}
          {accountNavigation.length > 0 ? <DropdownMenuSeparator /> : null}

          <DropdownMenuItem
            asChild
            className={docsActive ? "bg-accent text-accent-foreground" : undefined}
            data-testid="account-nav-docs"
          >
            <Link
              to="/docs"
              data-testid="account-link-docs"
              aria-current={docsActive ? "page" : undefined}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
            >
              <BookText data-icon="inline-start" />
              {t("docs.menu")}
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => setReleaseNotesOpen(true)}
            data-testid="account-release-notes"
          >
            <History data-icon="inline-start" />
            {t("releaseNotes.menu")}
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="account-profile-menu">
              <UserRound data-icon="inline-start" />
              {t("account.profile")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72" data-testid="account-profile-content">
              <DropdownMenuLabel>
                <span className="block truncate text-sm font-medium text-foreground">
                  {identity}
                </span>
                <span className="mt-1 block truncate font-normal">
                  {t("account.role")}: {role}
                </span>
                <span className="block truncate font-normal">
                  {t("account.tenant")}: {session.tenant.display_name}
                </span>
                <span className="block truncate font-normal">
                  {t("account.engineVersion", { version: session.version })}
                </span>
              </DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="account-language-menu">
              <Languages data-icon="inline-start" />
              {t("account.language")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="account-language-content">
              <DropdownMenuRadioGroup
                value={preference}
                onValueChange={(value) => setPreference(value as LocalePreference)}
              >
                {LANGUAGES.map(({ value, label }) => (
                  <DropdownMenuRadioItem
                    key={value}
                    value={value}
                    data-testid={`account-language-${value}`}
                  >
                    {t(label)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="account-theme-menu">
              <Palette data-icon="inline-start" />
              {t("account.theme")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="account-theme-content">
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(value) => setTheme(value as Theme)}
              >
                {THEMES.map(({ value, label, icon: Icon }) => (
                  <DropdownMenuRadioItem
                    key={value}
                    value={value}
                    data-testid={`account-theme-${value}`}
                  >
                    <Icon data-icon="inline-start" />
                    {t(label)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={signingOut}
            data-testid="account-sign-out"
            onSelect={() => void signOut()}
          >
            {signingOut ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <LogOut data-icon="inline-start" />
            )}
            {t(signingOut ? "account.signingOut" : "account.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ReleaseNotesDialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} />
    </>
  );
}
