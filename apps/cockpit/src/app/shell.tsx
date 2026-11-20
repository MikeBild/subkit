import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BookText,
  Bug,
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
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { ActionFailureHost } from "@/components/cockpit/patterns";
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
import {
  FeedbackButton,
  FeedbackHost,
  FeedbackIconButton,
  openFeedback,
} from "@/features/feedback";
import { releaseOnSignOut } from "@/features/pwa/device-state";
import { PwaRuntime } from "@/features/pwa/pwa-runtime";
import { clearFailure, reportFailure } from "@/lib/action-failure";
import type { TranslationKey } from "@/lib/i18n";
import { type LocalePreference, useI18n } from "@/lib/i18n-context";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { RunOverlays } from "@/pages/runs";
import { AttentionNotice } from "./attention-notice";
import { useAttentionFresh } from "./attention-seen";
import { InstallMenuItem } from "./install-menu-item";
import { cockpitBasePath } from "./installation-context";
import { LiveEventsProvider, useLiveStatus } from "./live-events";
import { AttentionDot, LiveStatusRow } from "./live-indicator";
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
import { SidePanel, SidePanelProvider, SidePanelToggle } from "./side-panel";
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
  const active = navigationItem(pathname);
  const brandName =
    installationId() || session.branding?.configured ? session.tenant.display_name : t("app.name");

  return (
    <LiveEventsProvider>
      <BrandingAppearance />
      <SidebarProvider
        data-testid="cockpit-shell"
        data-cockpit-ui
        className="h-full min-h-0 overflow-clip"
      >
        <CloseNavigationOnRoute pathname={pathname} />
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
                  <SidebarMenuButton asChild size="lg" className="relative" tooltip={brandName}>
                    <Link to="/" data-testid="cockpit-home-link">
                      <BrandingWordmark />
                      <AttentionCounter />
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarHeader>

          <SidebarContent
            data-testid="cockpit-navigation"
            key={pathname}
            className="group-data-[collapsible=icon]:overflow-y-auto"
          >
            <nav aria-label={t("nav.label")}>
              {groups.map((group) => (
                <SidebarGroup key={group.id} data-testid={`nav-group-${group.id}`}>
                  {group.labelKey && (
                    <SidebarGroupLabel className="overflow-hidden group-data-[collapsible=icon]:mx-2 group-data-[collapsible=icon]:my-2 group-data-[collapsible=icon]:h-px group-data-[collapsible=icon]:bg-sidebar-border group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:text-transparent group-data-[collapsible=icon]:opacity-100">
                      {t(group.labelKey)}
                    </SidebarGroupLabel>
                  )}
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
            <ShellLiveStatusRow
              actions={
                <>
                  <InstallationNotificationControl />
                  <FeedbackIconButton />
                  <DesktopSidebarToggle />
                </>
              }
            />
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

        <SidePanelProvider>
          <SidebarInset className="min-h-0 min-w-0 overflow-clip" data-testid="cockpit-content">
            <ShellContent />
          </SidebarInset>
          <SidePanel pathname={pathname} />
        </SidePanelProvider>
        <Toaster richColors position="bottom-right" />
        <InstallationImportDialog />
        <VersionNotice />
        <FeedbackHost />
        <AttentionNotice />
        <PwaRuntime />
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
              <MobileAttentionToggle className="-ml-1 shrink-0" mobile={isMobile} />
              <div ref={header.setSlot} className="min-w-0 flex-1" />
              <SidePanelToggle className="-mr-1 shrink-0" />
            </div>
          </header>
        ) : (
          <header
            className="flex h-12 shrink-0 items-center gap-3 border-b px-4 sm:px-6"
            data-testid="cockpit-header"
          >
            <MobileAttentionToggle className="-ml-1" mobile={isMobile} />
            <FeedbackButton className="ml-auto" />
            <SidePanelToggle className="-mr-1" />
          </header>
        ))}
      <ResponsiveWorkspace>
        <div
          ref={content}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip"
          data-testid="page-content"
        >
          <ActionFailureBase page={page} />
          <Outlet />
        </div>
        <RunOverlays />
      </ResponsiveWorkspace>
    </ShellHeaderProvider>
  );
}

function ActionFailureBase({ page }: { page: string }) {
  const client = useQueryClient();
  useEffect(() => {
    if (page) clearFailure();
  }, [page]);
  useEffect(
    () =>
      client.getMutationCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success") clearFailure();
      }),
    [client],
  );
  return <ActionFailureHost level="base" className="shrink-0 px-4 pt-3 sm:px-6" />;
}

function CloseNavigationOnRoute({ pathname }: { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    if (pathname) setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}

function DesktopSidebarToggle() {
  const { isMobile } = useSidebar();
  return isMobile ? null : <SidebarToggle className="shrink-0" />;
}

function MobileAttentionToggle({ className, mobile }: { className: string; mobile: boolean }) {
  const session = useSession();
  const fresh = useAttentionFresh(session);
  if (!mobile || !fresh) return <SidebarToggle className={className} />;
  return (
    <span className="relative inline-flex shrink-0" data-testid="sidebar-trigger-attention">
      <SidebarToggle className={className} />
      <AttentionDot stopped={fresh.stopped} className="top-1.5 right-1.5" />
    </span>
  );
}

function AttentionCounter() {
  const session = useSession();
  const { query, badge } = useAttention(session.permissions);
  if (query.isError || badge === null || badge.count === 0) return null;
  return (
    <>
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
      <span
        aria-hidden="true"
        data-testid="nav-overview-dot"
        className={cn(
          "pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:block",
          badge.stopped ? "bg-destructive" : "bg-amber-500",
        )}
      />
    </>
  );
}

function ShellLiveStatusRow({ actions }: { actions: ReactNode }) {
  const { status } = useLiveStatus();
  return <LiveStatusRow status={status} actions={actions} />;
}

function AccountMenu() {
  const session = useSession();
  const { t, preference, setPreference } = useI18n();
  const { theme, setTheme } = useTheme();
  const { isMobile, setOpenMobile } = useSidebar();
  const [signingOut, setSigningOut] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const identity =
    session.principal.display_name?.trim() ||
    session.principal.email ||
    session.principal.role_name ||
    t("common.member");
  const role = localizedRole(session.principal.role_name || "member", t);
  const accountNavigation = visibleAccountNavigation(session.permissions);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const current = pathname;
  const active = navigationItem(current);
  const docsActive = current === "/docs" || current.startsWith("/docs/");
  const profileActive = useRouterState({
    select: (state) =>
      state.location.pathname === "/settings" &&
      new URLSearchParams(state.location.searchStr).get("area") === "profile",
  });

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      const { endSessionUrl } = await logout();
      await releaseOnSignOut();
      window.location.assign(endSessionUrl ?? cockpitBasePath());
    } catch (failure) {
      reportFailure(t("account.signOutFailed"), failure, {
        body: t("account.signOutFailedDescription"),
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
          className="w-64 max-h-[min(80dvh,640px)] overflow-y-auto"
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

          <InstallMenuItem />

          <DropdownMenuItem onSelect={() => openFeedback()} data-testid="account-feedback">
            <Bug data-icon="inline-start" />
            {t("feedback.menu")}
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => setReleaseNotesOpen(true)}
            data-testid="account-release-notes"
          >
            <History data-icon="inline-start" />
            {t("releaseNotes.menu")}
          </DropdownMenuItem>

          <DropdownMenuItem
            asChild
            className={profileActive ? "bg-accent text-accent-foreground" : undefined}
            data-testid="account-profile-menu"
          >
            <Link
              to="/settings"
              search={{ area: "profile" }}
              data-testid="account-link-profile"
              aria-current={profileActive ? "page" : undefined}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
            >
              <UserRound data-icon="inline-start" />
              <span className="grid min-w-0">
                <span>{t("account.profile")}</span>
                <span
                  className="truncate text-xs font-normal text-muted-foreground"
                  data-testid="account-profile-summary"
                >
                  {identity} · {role}
                </span>
              </span>
            </Link>
          </DropdownMenuItem>

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
