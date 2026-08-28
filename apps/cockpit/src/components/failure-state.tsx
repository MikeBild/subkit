import type { ErrorComponentProps } from "@tanstack/react-router";
import { RouteOff, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { FAMILY_UI_VERSION, FamilyFailureState } from "@/components/family-ui";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";

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
        <Button asChild>
          <a href="/cockpit" data-testid="not-found-home">
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
        <Button variant="outline" asChild>
          <a href="/cockpit" data-testid="fatal-error-home">
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
