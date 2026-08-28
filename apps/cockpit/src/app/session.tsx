import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { ApiError, type Bootstrap, bootstrap } from "@/api/client";
import { BootstrapErrorPage, LoginRedirect } from "@/components/failure-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n-context";

const SessionContext = createContext<Bootstrap | null>(null);

export function useSession(): Bootstrap {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession requires SessionGate");
  return session;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ["bootstrap"], queryFn: bootstrap, retry: false });
  if (query.isPending) {
    return (
      <div
        className="mx-auto grid min-h-svh max-w-5xl content-center gap-4 p-8"
        data-testid="session-loading"
        role="status"
        aria-label={t("common.loading")}
      >
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.error instanceof ApiError && query.error.status === 401) {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const href = `/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`;
    return <LoginRedirect href={href} label={t("common.loading")} />;
  }
  if (query.error || !query.data) {
    return <BootstrapErrorPage onRetry={() => void query.refetch()} />;
  }
  return <SessionContext.Provider value={query.data}>{children}</SessionContext.Provider>;
}
