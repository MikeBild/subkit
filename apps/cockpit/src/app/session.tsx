import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import {
  ApiError,
  type Bootstrap,
  bootstrap,
  bootstrapLimits,
  onSessionExpired,
} from "@/api/client";
import {
  observeTenantSwitches,
  onTenantContextChanged,
  tenantContextChanged,
} from "@/api/tenant-context";
import { WorkspaceChangedPage } from "@/components/cockpit/patterns/workspace-changed";
import { BootstrapErrorPage, LoginRedirect, SessionExpiredPage } from "@/components/failure-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n-context";

const SessionContext = createContext<Bootstrap | null>(null);

const BOOTSTRAP_KEY = ["bootstrap"] as const;

export function useSession(): Bootstrap {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession requires SessionGate");
  return session;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [changed, setChanged] = useState(tenantContextChanged);
  const query = useQuery({
    queryKey: BOOTSTRAP_KEY,
    queryFn: () => bootstrap(bootstrapLimits(client.getQueryData<Bootstrap>(BOOTSTRAP_KEY))),
    retry: false,
    enabled: !changed,
  });
  const [expired, setExpired] = useState(false);
  useEffect(() => onSessionExpired(() => setExpired(true)), []);
  useEffect(
    () =>
      onTenantContextChanged(() => {
        setChanged(true);
      }),
    [client],
  );
  useEffect(() => {
    if (changed) void client.cancelQueries().then(() => client.clear());
  }, [changed, client]);
  useEffect(observeTenantSwitches, []);
  const view = sessionView(query, expired, changed);
  if (view === "changed") return <WorkspaceChangedPage />;
  if (view === "expired") return <SessionExpiredPage href={loginHref()} />;
  if (view === "signed-out")
    return <LoginRedirect href={loginHref()} label={t("common.loading")} />;
  if (view === "loading") return <SessionSkeleton label={t("common.loading")} />;
  if (view === "failed" || !query.data) {
    return <BootstrapErrorPage onRetry={() => void query.refetch()} />;
  }
  return <SessionContext.Provider value={query.data}>{children}</SessionContext.Provider>;
}

export type SessionView = "changed" | "expired" | "signed-out" | "loading" | "failed" | "ready";

export function sessionView(
  query: { isPending: boolean; error: unknown; data: Bootstrap | undefined },
  expired: boolean,
  changed = false,
): SessionView {
  if (changed || (query.error instanceof ApiError && query.error.code === "tenant_context_changed"))
    return "changed";
  if (query.data && (expired || (query.error instanceof ApiError && query.error.status === 401)))
    return "expired";
  if (expired || (query.error instanceof ApiError && query.error.status === 401))
    return "signed-out";
  if (query.data) return "ready";
  if (query.isPending) return "loading";
  return "failed";
}

const SKELETON_NAVIGATION = 9;
const SKELETON_ROWS = 3;

export function SessionSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex h-svh min-h-0 overflow-hidden bg-background"
      data-testid="session-loading"
      data-skeleton="shell"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <div
        className="hidden w-64 shrink-0 flex-col gap-2 border-r bg-sidebar p-2 md:flex"
        data-skeleton="sidebar"
      >
        <Skeleton className="h-12 w-full" />
        <div className="mt-2 flex flex-col gap-1">
          {Array.from({ length: SKELETON_NAVIGATION }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
        <Skeleton className="mt-auto h-12 w-full" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col" data-skeleton="content">
        <div className="h-12 shrink-0 border-b md:hidden" />
        <div className="flex w-full max-w-[1280px] flex-col gap-6 px-4 py-6 sm:px-6">
          <Skeleton className="h-8 w-48" />
          <div className="flex flex-col gap-1">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function loginHref(
  location: Pick<Location, "pathname" | "search"> = window.location,
): string {
  const returnTo = `${location.pathname}${location.search}`;
  return `/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`;
}
