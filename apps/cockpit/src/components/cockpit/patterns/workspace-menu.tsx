import { Link } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Download, Loader2, User, Users, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import type { Membership } from "@/api/memberships";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useI18n } from "@/lib/i18n-context";

export function WorkspaceMenu({
  items,
  tenantId,
  tenantName,
  wordmark,
  attention,
  changing,
  changingTenantId,
  loading,
  loadError,
  changeError,
  open,
  onOpenChange,
  onSwitch,
  onInstall,
  currentOnly = false,
  onRevoke,
}: {
  items: Membership[] | undefined;
  tenantId: string;
  tenantName: string;
  wordmark?: ReactNode;
  attention?: ReactNode;
  changing: boolean;
  changingTenantId: string | undefined;
  loading: boolean;
  loadError: unknown;
  changeError: unknown;
  open: boolean;
  onOpenChange(value: boolean): void;
  onSwitch(id: string): void;
  onInstall?(): void;
  currentOnly?: boolean;
  onRevoke?(): void;
}) {
  const { t } = useI18n();
  const { isMobile, setOpenMobile } = useSidebar();
  const pending = items?.find((item) => changing && item.tenant_id === changingTenantId);
  return (
    <SidebarMenu>
      <SidebarMenuItem
        data-testid="cockpit-wordmark"
        className="flex min-w-0 items-center gap-1 group-data-[collapsible=icon]:flex-col"
        onClick={(event) => {
          if (
            isMobile &&
            (event.target as HTMLElement).closest('[data-testid="cockpit-home-link"]')
          )
            setOpenMobile(false);
        }}
      >
        <SidebarMenuButton asChild size="lg" className="min-w-0 flex-1" tooltip={tenantName}>
          <Link to="/" data-testid="cockpit-home-link" aria-label={tenantName}>
            {wordmark ?? (
              <>
                <div
                  data-testid="cockpit-wordmark-icon"
                  className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                >
                  <Workflow className="size-4" />
                </div>
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span
                    data-testid="cockpit-wordmark-name"
                    className="truncate text-sm font-semibold"
                  >
                    {t("app.name")}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {pending?.display_name ?? tenantName}
                  </span>
                </div>
              </>
            )}
            {pending ? <Loader2 className="size-3 animate-spin" /> : null}
            {attention}
          </Link>
        </SidebarMenuButton>
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              aria-label={t("workspace.switch")}
              aria-busy={changing}
              className="size-8 shrink-0 justify-center pointer-coarse:w-11 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <ChevronsUpDown className="size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-64 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {t("workspace.label")}
            </DropdownMenuLabel>
            {loading ? (
              <div
                className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                {t("workspace.loading")}
              </div>
            ) : null}
            {items?.length === 0 ? (
              <p className="px-2 py-2 text-sm">{t("workspace.empty")}</p>
            ) : null}
            {items?.map((item) => {
              const current = item.tenant_id === tenantId;
              const waiting = changing && item.tenant_id === changingTenantId;
              return (
                <DropdownMenuItem
                  data-testid="workspace-switch-option"
                  key={item.tenant_id}
                  disabled={changing || current}
                  aria-current={current ? "true" : undefined}
                  className="gap-2 p-2 data-[disabled]:opacity-100"
                  onSelect={() => onSwitch(item.tenant_id)}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border">
                    {item.is_owner ? <User className="size-3.5" /> : <Users className="size-3.5" />}
                  </div>
                  <div className="grid flex-1 leading-tight">
                    <span className="flex items-center gap-1.5 truncate text-sm">
                      {item.display_name}
                      {item.is_owner ? (
                        <span className="rounded-sm bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                          {t("workspace.own")}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {item.is_owner
                        ? t("workspace.owner")
                        : item.role === "admin"
                          ? t("role.admin")
                          : item.role === "member"
                            ? t("role.member")
                            : item.role}
                    </span>
                  </div>
                  {waiting ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : current ? (
                    <Check className="size-4" aria-label={t("workspace.current")} />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
            {currentOnly ? (
              <DropdownMenuItem
                disabled
                className="gap-2 p-2 data-[disabled]:opacity-100"
                data-testid="workspace-current"
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <Workflow className="size-3.5" />
                </div>
                <span className="flex-1 truncate text-sm">{tenantName}</span>
                <Check className="size-4" aria-label={t("workspace.current")} />
              </DropdownMenuItem>
            ) : null}
            {items?.length === 1 ? (
              <>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("workspace.single")}</p>
              </>
            ) : null}
            {onInstall ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2"
                  data-testid="workspace-install"
                  onSelect={onInstall}
                >
                  <Download className="size-4 text-muted-foreground" />
                  {t("installation.install")}
                </DropdownMenuItem>
              </>
            ) : null}
            {onRevoke ? (
              <DropdownMenuItem
                className="gap-2 text-destructive focus:text-destructive"
                data-testid="workspace-revoke-installation"
                onSelect={onRevoke}
              >
                <Download className="size-4" />
                {t("installation.revoke")}
              </DropdownMenuItem>
            ) : null}
            {changeError || loadError ? (
              <>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-destructive" role="alert">
                  {t("workspace.error")}
                </p>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
