import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Bug,
  ChevronsUpDown,
  Globe,
  KeyRound,
  Loader2,
  LogOut,
  Palette,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { logout } from "@/api/client";
import { installationId } from "@/app/installation-context";
import { PauseMenu } from "@/app/pause-menu";
import {
  BrandingAppearance,
  BrandingAttribution,
  BrandingWordmark,
} from "@/components/cockpit/branding";
import { InstallationFollowupPrompt } from "@/components/cockpit/installation-dialogs";
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
import { FeedbackHost, openFeedback } from "@/features/feedback";
import { PwaRuntime, releaseOnSignOut } from "@/features/pwa";
import { clearFailure, reportFailure } from "@/lib/action-failure";
import type { TranslationKey } from "@/lib/i18n";
import { type LocalePreference, useI18n } from "@/lib/i18n-context";
import { readStartLayout } from "@/lib/start-layout";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { attentionEntries } from "@/pages/overview-model";
import { RunOverlays } from "@/pages/runs";
import { visibleSettingAreas } from "@/pages/settings-areas";
import { accountMenuFallbacks } from "./account-menu-model";
import { inboxCount } from "./attention-model";
import { AttentionNotice } from "./attention-notice";
import { DesktopStatusBanner } from "./desktop-status";
import { cockpitBasePath } from "./installation-context";
import { LiveEventsProvider } from "./live-events";
import { useNavShortcuts } from "./nav-shortcuts";
import { navShortcutAria, navShortcutLabel } from "./nav-shortcuts-model";
import { type NavigationItem, navigationItem, visibleSidebarNavigation } from "./navigation";
import { pageOf, useRouteEntrance } from "./route-entrance";
import { useSession } from "./session";
import { ACCOUNT_TRIGGER, SHELL_BAR, ShellHeader } from "./shell-header";
import { SidePanel, SidePanelProvider } from "./side-panel";
import { useAttention } from "./use-attention";
import { VersionNotice } from "./version-notice";

const THEMES: { value: Theme; label: TranslationKey }[] = [
  { value: "system", label: "account.theme.system" },
  { value: "light", label: "account.theme.light" },
  { value: "dark", label: "account.theme.dark" },
];

const LANGUAGES: { value: LocalePreference; label: TranslationKey }[] = [
  { value: "auto", label: "account.language.auto" },
  { value: "de", label: "account.language.de" },
  { value: "en", label: "account.language.en" },
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
  shortcut,
  keys,
  active,
}: {
  item: NavigationItem;
  label: string;
  shortcut: string | null;
  keys: string | null;
  active: boolean;
}) {
  const { isMobile, setOpenMobile, state } = useSidebar();
  const hint = shortcut ? `${label} (${shortcut})` : label;
  return (
    <SidebarMenuButton
      asChild
      tooltip={hint}
      isActive={active}
      className={item.path === "/" || item.path === "/intake" ? "relative" : undefined}
    >
      <Link
        to={item.path}
        data-testid={item.path === "/" ? "nav-overview" : `nav-${item.path.slice(1)}`}
        aria-keyshortcuts={keys ?? undefined}
        title={shortcut && state === "expanded" && !isMobile ? hint : undefined}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
        }}
      >
        <item.icon data-icon="inline-start" />
        <span>{label}</span>
        {item.path === "/" ? <AttentionCounter /> : null}
        {item.path === "/intake" ? <InboxCounter /> : null}
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
  const groups = visibleSidebarNavigation(session.permissions);
  const paths = groups.flatMap((group) => group.items.map((item) => item.path));
  const shortcuts = useNavShortcuts(paths);
  const [startLayout] = useState(readStartLayout);
  const active = navigationItem(pathname);
  const brandName =
    installationId() || session.branding?.configured ? session.tenant.display_name : t("app.name");

  return (
    <LiveEventsProvider>
      <BrandingAppearance />
      <SidebarProvider
        defaultOpen={!startLayout.leftCollapsed}
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
          <SidebarHeader
            data-testid="cockpit-sidebar-header"
            className={cn(SHELL_BAR, "justify-center border-sidebar-border py-0")}
          >
            {!installationId() ? (
              <WorkspaceSwitcher />
            ) : (
              <SidebarMenu>
                <SidebarMenuItem data-testid="cockpit-wordmark">
                  <SidebarMenuButton asChild size="lg" tooltip={brandName}>
                    <Link to="/" data-testid="cockpit-home-link">
                      <BrandingWordmark />
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarHeader>

          <SidebarContent
            data-testid="cockpit-navigation"
            key={pathname}
            className="shrink-0 overflow-visible pt-2 group-data-[collapsible=icon]:overflow-visible"
          >
            <nav aria-label={t("nav.label")}>
              {groups.map((group) => (
                <SidebarGroup
                  key={group.id}
                  className="px-2 py-0"
                  data-testid={`nav-group-${group.id}`}
                >
                  {group.labelKey && (
                    <SidebarGroupLabel className="overflow-hidden group-data-[collapsible=icon]:mx-2 group-data-[collapsible=icon]:my-2 group-data-[collapsible=icon]:h-px group-data-[collapsible=icon]:bg-sidebar-border group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:text-transparent group-data-[collapsible=icon]:opacity-100">
                      {t(group.labelKey)}
                    </SidebarGroupLabel>
                  )}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item) => {
                        const label = t(item.labelKey);
                        const index = paths.indexOf(item.path);
                        const shortcut = shortcuts.appWindow
                          ? navShortcutLabel(index, shortcuts.mac)
                          : null;
                        return (
                          <SidebarMenuItem key={item.path}>
                            <PrimaryNavigationLink
                              item={item}
                              label={label}
                              shortcut={shortcut}
                              keys={shortcut ? navShortcutAria(index) : null}
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
            className="gap-1 border-t border-sidebar-border"
          >
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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="shell-column">
            <ShellHeader />
            <DesktopStatusBanner />
            <div className="flex min-h-0 min-w-0 flex-1" data-slot="shell-body">
              <SidebarInset className="min-h-0 min-w-0 overflow-clip" data-testid="cockpit-content">
                <ShellContent />
              </SidebarInset>
              <SidePanel pathname={pathname} />
            </div>
          </div>
        </SidePanelProvider>
        <Toaster richColors position="bottom-right" />
        <InstallationImportDialog />
        <VersionNotice />
        <RoutedFeedbackHost />
        <AttentionNotice />
        <PwaRuntime />
      </SidebarProvider>
    </LiveEventsProvider>
  );
}

function RoutedFeedbackHost() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return <FeedbackHost pathname={pathname} search={search} />;
}

function ShellContent() {
  const page = useRouterState({
    select: (state) => pageOf(state.location.pathname),
  });
  const content = useRef<HTMLDivElement>(null);
  useRouteEntrance(content, page);
  return (
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
  return <ActionFailureHost level="base" className="shrink-0 px-4 pt-3 sm:px-8" />;
}

function CloseNavigationOnRoute({ pathname }: { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    if (pathname) setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}

function InboxCounter() {
  const session = useSession();
  const { query, hidden } = useAttention(session.permissions);
  const count = inboxCount(attentionEntries(query.data?.items ?? [], hidden));
  if (count === 0) return null;
  return (
    <>
      <span
        className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-2 font-mono text-xs tabular-nums group-data-[collapsible=icon]:hidden"
        data-testid="nav-intake-count"
      >
        {count}
      </span>
      <span
        aria-hidden="true"
        data-testid="nav-intake-dot"
        className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-accent ring-2 ring-sidebar group-data-[collapsible=icon]:block"
      />
    </>
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
          "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-2 font-mono text-xs tabular-nums group-data-[collapsible=icon]:hidden",
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
          badge.stopped ? "bg-destructive" : "bg-accent",
        )}
      />
    </>
  );
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
  const fallbacks = accountMenuFallbacks({
    permissions: session.permissions,
    settingAreas: visibleSettingAreas({
      permissions: session.permissions,
      isOwner: session.principal.is_owner,
      origin: session.tenant.origin,
    }),
  });
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const under = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const closeOnPhone = () => {
    if (isMobile) setOpenMobile(false);
  };

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

  const languages = (
    <DropdownMenuRadioGroup
      value={preference}
      onValueChange={(value) => setPreference(value as LocalePreference)}
    >
      {LANGUAGES.map(({ value, label }) => (
        <DropdownMenuRadioItem key={value} value={value} data-testid={`account-language-${value}`}>
          {t(label)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  const themes = (
    <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
      {THEMES.map(({ value, label }) => (
        <DropdownMenuRadioItem key={value} value={value} data-testid={`account-theme-${value}`}>
          {t(label)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );

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
              className="ml-auto shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
            />
          </SidebarMenuButton>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side={isMobile ? "top" : "right"}
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="w-64"
          data-testid="account-menu"
        >
          <DropdownMenuLabel className="font-normal" data-testid="account-summary">
            <span className="block text-sm font-medium whitespace-normal text-foreground [overflow-wrap:anywhere]">
              {identity}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {session.tenant.display_name}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem
            asChild
            className={under("/settings") ? "bg-accent text-accent-foreground" : undefined}
            data-testid="account-nav-settings"
          >
            <Link
              to="/settings"
              data-testid="account-link-settings"
              aria-current={under("/settings") ? "page" : undefined}
              onClick={closeOnPhone}
            >
              <SettingsIcon data-icon="inline-start" />
              {t("nav.settings")}
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => openFeedback()} data-testid="account-feedback">
            <Bug data-icon="inline-start" />
            {t("feedback.menu")}
          </DropdownMenuItem>

          <DropdownMenuItem
            asChild
            className={under("/docs") ? "bg-accent text-accent-foreground" : undefined}
            data-testid="account-nav-docs"
          >
            <Link
              to="/docs"
              data-testid="account-link-docs"
              aria-current={under("/docs") ? "page" : undefined}
              onClick={closeOnPhone}
            >
              <BookOpen data-icon="inline-start" />
              {t("docs.menu")}
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => setReleaseNotesOpen(true)}
            data-testid="account-release-notes"
          >
            <Sparkles data-icon="inline-start" />
            {t("releaseNotes.menu")}
          </DropdownMenuItem>

          {fallbacks.apiAccess ? (
            <DropdownMenuItem
              asChild
              className={under("/api-access") ? "bg-accent text-accent-foreground" : undefined}
              data-testid="account-nav-api-access"
            >
              <Link
                to="/api-access"
                data-testid="account-link-api-access"
                aria-current={under("/api-access") ? "page" : undefined}
                onClick={closeOnPhone}
              >
                <KeyRound data-icon="inline-start" />
                {t("nav.apiAccess")}
              </Link>
            </DropdownMenuItem>
          ) : null}
          {fallbacks.pause ? <PauseMenu /> : null}

          <DropdownMenuSeparator />
          {isMobile ? (
            <>
              <DropdownMenuLabel
                className="text-xs font-medium text-muted-foreground"
                data-testid="account-language-menu"
              >
                {t("account.language")}
              </DropdownMenuLabel>
              {languages}
              <DropdownMenuSeparator />
              <DropdownMenuLabel
                className="text-xs font-medium text-muted-foreground"
                data-testid="account-theme-menu"
              >
                {t("account.theme")}
              </DropdownMenuLabel>
              {themes}
            </>
          ) : (
            <>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="account-language-menu">
                  <Globe data-icon="inline-start" />
                  {t("account.language")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  collisionPadding={8}
                  className="w-48"
                  data-testid="account-language-content"
                >
                  {languages}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="account-theme-menu">
                  <Palette data-icon="inline-start" />
                  {t("account.theme")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  collisionPadding={8}
                  className="w-48"
                  data-testid="account-theme-content"
                >
                  {themes}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
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
