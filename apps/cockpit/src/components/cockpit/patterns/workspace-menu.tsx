import { Check, ChevronsUpDown, Loader2, User, Users, Workflow } from "lucide-react";
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
  changing,
  changingTenantId,
  loading,
  loadError,
  changeError,
  open,
  onOpenChange,
  onSwitch,
}: {
  items: Membership[] | undefined;
  tenantId: string;
  tenantName: string;
  wordmark?: ReactNode;
  changing: boolean;
  changingTenantId: string | undefined;
  loading: boolean;
  loadError: unknown;
  changeError: unknown;
  open: boolean;
  onOpenChange(value: boolean): void;
  onSwitch(id: string): void;
}) {
  const { t } = useI18n();
  const { isMobile } = useSidebar();
  const pending = items?.find((item) => changing && item.tenant_id === changingTenantId);
  return (
    <SidebarMenu>
      <SidebarMenuItem data-testid="cockpit-wordmark">
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={t("workspace.switch")}
              aria-busy={changing}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
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
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
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
            {items?.length === 1 ? (
              <>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("workspace.single")}</p>
              </>
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
