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
  BreadcrumbList,
  BreadcrumbPage,
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import type { TranslationKey } from "@/lib/i18n";
import { type LocalePreference, useI18n } from "@/lib/i18n-context";
import { type Theme, useTheme } from "@/lib/theme";
import { navigationItem, visibleNavigation } from "./navigation";
import { useSession } from "./session";

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

export function AppShell() {
  const session = useSession();
  const { t } = useI18n();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = navigationItem(pathname.replace(/^\/cockpit/, ""));
  const groups = visibleNavigation(session.permissions);

  return (
    <SidebarProvider data-testid="cockpit-shell" data-cockpit-ui className="h-full min-h-0">
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
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg" tooltip={t("app.name")}>
                <Link to="/chat" data-testid="cockpit-home-link">
                  <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
                    <Workflow data-icon="inline-start" />
                  </span>
                  <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{t("app.name")}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {session.tenant.display_name}
                    </span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent data-testid="cockpit-navigation">
          <nav aria-label={t("nav.label")}>
            {groups.map((group) => (
              <SidebarGroup key={group.id} data-testid={`nav-group-${group.id}`}>
                <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const label = t(item.labelKey);
                      return (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton
                            asChild
                            tooltip={label}
                            isActive={pathname.endsWith(item.path)}
                          >
                            <Link to={item.path} data-testid={`nav-${item.path.slice(1)}`}>
                              <item.icon data-icon="inline-start" />
                              <span>{label}</span>
                            </Link>
                          </SidebarMenuButton>
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
        <header
          className="flex h-12 shrink-0 items-center gap-3 border-b px-4"
          data-testid="cockpit-header"
        >
          <SidebarTrigger
            className="-ml-1"
            label={t("nav.toggle")}
            aria-label={t("nav.toggle")}
            data-testid="sidebar-trigger"
          />
          <Breadcrumb data-testid="page-breadcrumb">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage data-testid="page-breadcrumb-current">
                  {current ? t(current.labelKey) : t("app.cockpit")}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="page-content">
          <Outlet />
        </div>
      </SidebarInset>
      <Toaster richColors position="bottom-right" />
    </SidebarProvider>
  );
}

function AccountMenu() {
  const session = useSession();
  const { t, preference, setPreference } = useI18n();
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const identity = session.principal.email || session.principal.role_name || t("common.member");
  const role = session.principal.role_name || t("common.member");

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await logout();
      window.location.assign("/cockpit/");
    } catch (error) {
      toast.error(t("account.signOutFailed"), {
        description: error instanceof Error ? error.message : undefined,
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
