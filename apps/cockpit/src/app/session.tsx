import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { ApiError, type Bootstrap, bootstrap, onSessionExpired } from "@/api/client";
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
  const [expired, setExpired] = useState(false);
  useEffect(() => onSessionExpired(() => setExpired(true)), []);
  const signedOut = expired || (query.error instanceof ApiError && query.error.status === 401);
  if (signedOut) return <LoginRedirect href={loginHref()} label={t("common.loading")} />;
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
  if (query.error || !query.data) {
    return <BootstrapErrorPage onRetry={() => void query.refetch()} />;
  }
  return <SessionContext.Provider value={query.data}>{children}</SessionContext.Provider>;
}

export function loginHref(
  location: Pick<Location, "pathname" | "search"> = window.location,
): string {
  const returnTo = `${location.pathname}${location.search}`;
  return `/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`;
}
