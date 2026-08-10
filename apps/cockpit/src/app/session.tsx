import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { ApiError, type Bootstrap, bootstrap } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    return (
      <main
        className="grid min-h-svh place-items-center bg-muted/30 p-6"
        data-testid="session-sign-in"
      >
        <Card className="w-full max-w-md" data-cockpit-ui="auth-card" data-testid="sign-in-card">
          <CardHeader>
            <CardTitle>{t("session.signIn.title")}</CardTitle>
            <CardDescription>{t("session.signIn.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t("session.signIn.explanation")}</p>
          </CardContent>
          <CardFooter>
            <Button asChild className="w-full" data-testid="sign-in-action">
              <a
                href={`/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`}
                data-testid="sign-in-link"
              >
                {t("session.signIn.action")}
              </a>
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }
  if (query.error || !query.data) {
    return (
      <main className="mx-auto max-w-xl p-8" data-testid="session-error">
        <Alert variant="destructive" data-testid="session-error-alert">
          <AlertTitle>{t("session.unavailable.title")}</AlertTitle>
          <AlertDescription>
            {query.error instanceof Error
              ? query.error.message
              : t("session.unavailable.description")}
          </AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="session-retry"
            onClick={() => void query.refetch()}
          >
            {t("session.retry")}
          </Button>
        </Alert>
      </main>
    );
  }
  return <SessionContext.Provider value={query.data}>{children}</SessionContext.Provider>;
}
