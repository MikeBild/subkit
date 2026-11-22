import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@ui/atoms/button";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { Lock, RouteOff, TriangleExclamationPoint } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { absolute } from "@/app/links";
import { useErrorNotice } from "@/components/cockpit/patterns/use-error-detail";
import { FailurePanel } from "@/components/ui-states";
import { useI18n } from "@/lib/i18n-context";

type QueryView = "loading" | "error" | "empty" | "ready";

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
  error,
  testId,
  children,
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
  error?: unknown;
  testId: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const notice = useErrorNotice({
    error,
    body: description ?? t("resource.loadFailedDescription"),
  });
  return (
    <ErrorNotice
      {...notice}
      testId={testId}
      title={title}
      actions={
        onRetry || children ? (
          <>
            {onRetry ? (
              <Button size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>
                {t("session.retry")}
              </Button>
            ) : null}
            {children}
          </>
        ) : undefined
      }
    />
  );
}

export function LoginRedirect({ href, label }: { href: string; label: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);

  return (
    <main
      className="grid min-h-full place-items-center bg-background"
      data-sk-surface="auth"
      data-testid="session-redirect"
      role="status"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
    </main>
  );
}

export function ForbiddenState({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <FailurePanel
      kind="forbidden"
      title={t("resource.permission.title")}
      description={t("resource.permission.description")}
      icon={<Lock className="size-4" />}
      data-testid="resource-permission-alert"
      className={className}
    />
  );
}

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <FailurePanel
      kind="not-found"
      title={t("failure.notFound.title")}
      description={t("failure.notFound.description")}
      icon={<RouteOff className="size-5" />}
      primaryAction={
        <Button asChild data-testid="not-found-home-action">
          <a href={absolute("/")} data-testid="not-found-home">
            {t("failure.overview")}
          </a>
        </Button>
      }
    />
  );
}

export function RouteErrorPage({ reset }: ErrorComponentProps) {
  const { t } = useI18n();
  return (
    <FailurePanel
      kind="fatal-error"
      title={t("failure.fatal.title")}
      description={t("failure.fatal.description")}
      icon={<TriangleExclamationPoint className="size-5" />}
      primaryAction={
        <Button type="button" onClick={reset} data-testid="fatal-error-retry">
          {t("failure.retry")}
        </Button>
      }
      secondaryAction={
        <Button variant="outline" asChild data-testid="fatal-error-home-action">
          <a href={absolute("/")} data-testid="fatal-error-home">
            {t("failure.overview")}
          </a>
        </Button>
      }
    />
  );
}

export function BootstrapErrorPage({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <FailurePanel
      kind="fatal-error"
      standalone
      title={t("failure.unreachable.title")}
      description={t("failure.bootstrap.description")}
      icon={<TriangleExclamationPoint className="size-5" />}
      primaryAction={
        <Button type="button" onClick={onRetry} data-testid="session-retry">
          {t("failure.retry")}
        </Button>
      }
    />
  );
}

export function SessionExpiredPage({ href }: { href: string }) {
  const { t } = useI18n();
  return (
    <FailurePanel
      kind="fatal-error"
      standalone
      title={t("failure.expired.title")}
      description={t("failure.expired.description")}
      icon={<Lock className="size-5" />}
      primaryAction={
        <Button asChild data-testid="session-expired-sign-in">
          <a href={href}>{t("failure.expired.signIn")}</a>
        </Button>
      }
    />
  );
}
