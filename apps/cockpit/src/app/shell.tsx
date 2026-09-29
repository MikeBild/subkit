import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  ChevronsUpDown,
  Languages,
  Loader2,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  Palette,
  Sun,
  UserRound,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { logout } from "@/api/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import type { TranslationKey } from "@/lib/i18n";
import { type LocalePreference, useI18n } from "@/lib/i18n-context";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { navigationItem, visibleNavigation } from "./navigation";
import { RecordCrumbProvider, recordListPath, useRecordCrumbLabel } from "./record-crumb";
import { useSession } from "./session";
import {
  CHAT_COLUMN,
  ShellHeaderProvider,
  SidebarToggle,
  triggerOwner,
  useShellHeaderState,
} from "./shell-header";
import { useAttention } from "./use-attention";

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

/** The shell, with the slot a record's page names itself in for the breadcrumb. */
export function AppShell() {
  return (
    <RecordCrumbProvider>
      <ShellFrame />
    </RecordCrumbProvider>
  );
}

function ShellFrame() {
  const session = useSession();
  const { t } = useI18n();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const groups = visibleNavigation(session.permissions);

  return (
    <SidebarProvider
      data-testid="cockpit-shell"
      data-cockpit-ui
      className="h-svh min-h-0 overflow-hidden"
    >
      <Sidebar
        collapsible="icon"
        mobileTitle={t("app.cockpit")}
        mobileDescription={t("nav.mobileDescription")}
        mobileCloseLabel={t("common.close")}
        mobileCloseTestId="cockpit-sidebar-mobile-close"
        data-testid="cockpit-sidebar"
        data-cockpit-ui="product-sidebar"
      >
        <SidebarHeader data-testid="cockpit-sidebar-header">
          <SidebarMenu>
            {/*
              The wordmark (§6): product icon plus the product name in its
              canonical spelling, top of the sidebar.

              "SubKit" is a proper name with an internal capital, so it lives in
              exactly ONE place — `app.name` in the catalogue, identical in EN
              and DE, because a name is not translated. No literal here, no
              `.toUpperCase()`, no `uppercase` class and no `tracking` wide
              enough to pull the internal capital apart.

              The three `cockpit-wordmark*` ids are the family's shared anchor
              for the convention check and the parity harness — one selector
              across six products instead of six dialects. They are COPIED from
              the family pattern, not imported: the convention is a document,
              not a package (§7).

              The name carries its own id rather than only the container: the
              all-caps guard reads the COMPUTED `text-transform` on the element
              the name is painted on, and a container does not necessarily carry
              the same value.
            */}
            <SidebarMenuItem data-testid="cockpit-wordmark">
              <SidebarMenuButton asChild size="lg" tooltip={t("app.name")}>
                <Link to="/chat" data-testid="cockpit-home-link">
                  <span
                    data-testid="cockpit-wordmark-icon"
                    className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"
                  >
                    <Workflow data-icon="inline-start" />
                  </span>
                  <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span data-testid="cockpit-wordmark-name" className="truncate font-semibold">
                      {t("app.name")}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {session.tenant.display_name}
                    </span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent data-testid="cockpit-navigation" key={pathname}>
          <nav aria-label={t("nav.label")}>
            {groups.map((group) => (
              <SidebarGroup key={group.id} data-testid={`nav-group-${group.id}`}>
                {/* No heading where the group has no name: Übersicht stands
                    ungrouped, and a rendered label above it makes it a group. */}
                {group.labelKey && <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const label = t(item.labelKey);
                      return (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton
                            asChild
                            tooltip={label}
                            isActive={
                              pathname === `/cockpit${item.path}` ||
                              pathname.startsWith(`/cockpit${item.path}/`)
                            }
                          >
                            <Link
                              to={item.path}
                              data-testid={
                                item.path === "/" ? "nav-overview" : `nav-${item.path.slice(1)}`
                              }
                            >
                              <item.icon data-icon="inline-start" />
                              <span>{label}</span>
                            </Link>
                          </SidebarMenuButton>
                          {item.path === "/" && <AttentionCounter />}
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>

        <SidebarFooter data-testid="cockpit-sidebar-footer">
          <SidebarMenu>
            <SidebarMenuItem>
              <AccountMenu />
            </SidebarMenuItem>
          </SidebarMenu>
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
    </SidebarProvider>
  );
}

/**
 * The top bar and the page below it.
 *
 * The bar is drawn only where it carries something (see `shell-header.tsx`):
 * on a phone, over a record with its breadcrumb, and as the chat's own header.
 * On a wide list page the page frame holds the toggle beside its heading, and
 * a bar holding nothing but that toggle would be a band of empty space.
 */
function ShellContent() {
  const { isMobile } = useSidebar();
  const header = useShellHeaderState();
  // Subscribed for its re-render, not its value: the run log opens a run with
  // `pushState`, which the router does not see, and names it here. The crumb
  // and the owner then read the same address in the same render, so they agree
  // on whether this is a record's page.
  useRecordCrumbLabel();
  const breadcrumb = recordListPath(window.location.pathname) !== null;
  const chat = header.chatHeaders > 0;
  const owner = triggerOwner({
    mobile: isMobile,
    breadcrumb,
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
          // The chat's header: the same column as its transcript and composer,
          // padding outside it and the gutter reserved on both edges, so the
          // toggle, the title and the messages begin on one line.
          <header
            className="scrollbar-thin shrink-0 overflow-hidden border-b px-4 py-2 sm:px-6 [scrollbar-gutter:stable_both-edges]"
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
            className="flex h-12 shrink-0 items-center gap-3 border-b px-4"
            data-testid="cockpit-header"
          >
            <SidebarToggle className="-ml-1" />
            <RecordBreadcrumb />
          </header>
        ))}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="page-content">
        <Outlet />
      </div>
    </ShellHeaderProvider>
  );
}

/**
 * "List › Record", on a record's own page and nowhere else.
 *
 * It used to print the current page's name on every page, directly above a
 * heading that said the same word. On a detail page it earns its place: the
 * list crumb is the way back, which is why it carries `detail-back` — the page
 * body no longer holds a second "back to list" button beside it.
 */
function RecordBreadcrumb() {
  const { t } = useI18n();
  const label = useRecordCrumbLabel();
  // The address as the browser holds it, not as the router last saw it: the
  // run log opens and closes a run with `history.pushState`, which the router
  // does not observe. The crumb re-renders on both — a router navigation
  // re-renders the shell, and a run opening or closing changes `label`.
  const listPath = recordListPath(window.location.pathname);
  const list = listPath ? navigationItem(listPath) : undefined;
  if (!listPath || !list) return null;
  return (
    <Breadcrumb data-testid="page-breadcrumb" data-family-slot="breadcrumbs">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to={listPath} data-testid="detail-back">
              {t(list.labelKey)}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {label ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate" data-testid="page-breadcrumb-current">
                {label}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The number of entries on Übersicht, or nothing at all — a stale or guessed badge
 * would be worse than an absent one, and it always sits on the link it counts.
 * Red while anything is stopped.
 */
function AttentionCounter() {
  const session = useSession();
  const { query, badge } = useAttention(session.permissions);
  if (query.isError || badge === null) return null;
  return (
    <SidebarMenuBadge
      className={badge.stopped ? "text-destructive" : undefined}
      data-testid="nav-overview-count"
      data-attention-stopped={String(badge.stopped)}
    >
      {badge.count}
    </SidebarMenuBadge>
  );
}

function AccountMenu() {
  const session = useSession();
  const { t, preference, setPreference } = useI18n();
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const identity = session.principal.email || session.principal.role_name || t("common.member");
  const role = localizedRole(session.principal.role_name || "member", t);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await logout();
      window.location.assign("/cockpit");
    } catch {
      toast.error(t("account.signOutFailed"), {
        description: t("account.signOutFailedDescription"),
      });
      setSigningOut(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" data-testid="account-menu-trigger" tooltip={t("account.menu")}>
          <Avatar>
            <AvatarFallback>{initials(identity)}</AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium" data-testid="account-name">
              {identity}
            </span>
            <span className="truncate text-xs text-muted-foreground" data-testid="account-role">
              {role}
            </span>
          </span>
          <ChevronsUpDown data-icon="inline-end" className="ml-auto" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="right" align="end" className="w-64" data-testid="account-menu">
        <DropdownMenuLabel data-testid="account-summary">
          <span className="block truncate text-sm font-medium text-foreground">{identity}</span>
          <span className="block truncate font-normal">{session.tenant.display_name}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="account-profile-menu">
            <UserRound data-icon="inline-start" />
            {t("account.profile")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72" data-testid="account-profile-content">
            <DropdownMenuLabel>
              <span className="block truncate text-sm font-medium text-foreground">{identity}</span>
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
  );
}
