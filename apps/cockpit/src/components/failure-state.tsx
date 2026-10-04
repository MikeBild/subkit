import type { ErrorComponentProps } from "@tanstack/react-router";
import { RouteOff, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { absolute } from "@/app/links";
import { FAMILY_UI_VERSION, FamilyFailureState } from "@/components/family-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";

export type QueryView = "loading" | "error" | "empty" | "ready";

export function queryView<T>(
  query: { data: T | undefined; error: unknown; failureReason?: unknown; isPending: boolean },
  isEmpty: (data: T) => boolean,
): QueryView {
  if (query.data !== undefined) return isEmpty(query.data) ? "empty" : "ready";
  if (query.error || query.failureReason) return "error";
  return "loading";
}

export function LoadFailed({
  title,
  description,
  onRetry,
  testId,
  children,
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
  testId: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Alert
      variant="destructive"
      data-testid={testId}
      data-family-slot="data-state"
      data-family-state="error"
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{description ?? t("resource.loadFailedDescription")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>
              {t("session.retry")}
            </Button>
          ) : null}
          {children}
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function LoginRedirect({ href, label }: { href: string; label: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);

  return (
    <main
      className="grid min-h-svh place-items-center bg-background"
      data-family-surface="auth"
      data-family-contract-version={FAMILY_UI_VERSION}
      data-testid="session-redirect"
      role="status"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
    </main>
  );
}

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <FamilyFailureState
      kind="not-found"
      title={t("familyFailure.notFound.title")}
      description={t("familyFailure.notFound.description")}
      icon={<RouteOff className="size-5" />}
      primaryAction={
        <Button asChild data-testid="not-found-home-action">
          <a href={absolute("/")} data-testid="not-found-home">
            {t("familyFailure.overview")}
          </a>
        </Button>
      }
    />
  );
}

export function RouteErrorPage({ reset }: ErrorComponentProps) {
  const { t } = useI18n();
  return (
    <FamilyFailureState
      kind="fatal-error"
      title={t("familyFailure.fatal.title")}
      description={t("familyFailure.fatal.description")}
      icon={<TriangleAlert className="size-5" />}
      primaryAction={
        <Button type="button" onClick={reset} data-testid="fatal-error-retry">
          {t("familyFailure.retry")}
        </Button>
      }
      secondaryAction={
        <Button variant="outline" asChild data-testid="fatal-error-home-action">
          <a href={absolute("/")} data-testid="fatal-error-home">
            {t("familyFailure.overview")}
          </a>
        </Button>
      }
    />
  );
}

export function BootstrapErrorPage({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <FamilyFailureState
      kind="fatal-error"
      standalone
      title={t("familyFailure.fatal.title")}
      description={t("familyFailure.bootstrap.description")}
      icon={<TriangleAlert className="size-5" />}
      primaryAction={
        <Button type="button" onClick={onRetry} data-testid="session-retry">
          {t("familyFailure.retry")}
        </Button>
      }
    />
  );
}
