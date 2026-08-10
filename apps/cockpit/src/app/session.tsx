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

const SessionContext = createContext<Bootstrap | null>(null);

export function useSession(): Bootstrap {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession requires SessionGate");
  return session;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const query = useQuery({ queryKey: ["bootstrap"], queryFn: bootstrap, retry: false });
  if (query.isPending) {
    return (
      <div className="mx-auto grid min-h-svh max-w-5xl content-center gap-4 p-8">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.error instanceof ApiError && query.error.status === 401) {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return (
      <main className="grid min-h-svh place-items-center bg-muted/30 p-6">
        <Card className="w-full max-w-md" data-cockpit-ui="auth-card">
          <CardHeader>
            <CardTitle>Sign in to Subkit</CardTitle>
            <CardDescription>
              Your cockpit uses the same identity provider as this Subkit engine.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Continue to your tenant-scoped workspace. Your role controls which tools and records
              are available.
            </p>
          </CardContent>
          <CardFooter>
            <Button asChild className="w-full">
              <a href={`/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`}>
                Continue to sign in
              </a>
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }
  if (query.error || !query.data) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <Alert variant="destructive">
          <AlertTitle>Cockpit unavailable</AlertTitle>
          <AlertDescription>
            {query.error instanceof Error
              ? query.error.message
              : "The engine did not return a session."}
          </AlertDescription>
        </Alert>
      </main>
    );
  }
  return <SessionContext.Provider value={query.data}>{children}</SessionContext.Provider>;
}
