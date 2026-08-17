import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, ListChecks, RefreshCw } from "lucide-react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { canSeeDecisions } from "@/app/use-decisions";
import { ContextHelp } from "@/components/cockpit/context-help";
import { IconButton } from "@/components/cockpit/icon-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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

type HealthDigest = components["schemas"]["OperatorHealthDigest"];

export function OverviewPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("stats:read");
  const canDecide = canSeeDecisions(session.permissions);
  const title = t("nav.overview");
  const query = useQuery({
    queryKey: ["overview", "health-digest"],
    enabled: allowed,
    queryFn: () => apiRequest<HealthDigest>("/v1/operator/health-digest"),
  });
  const digest = query.data;
  const failureGroups = digest ? [...digest.failure_groups].sort((a, b) => b.count - a.count) : [];
  const stuck = digest?.patch_candidates.items.filter((item) => item.stuck) ?? [];
  const oldestStuckDays = stuck.reduce((days, item) => Math.max(days, item.age_days), 0);

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="overview-page">
      <header
        className="flex shrink-0 flex-col items-stretch justify-between gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:px-8"
        data-testid="overview-header"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
            <ContextHelp
              label={t("resource.about", { resource: title })}
              testId="overview-description"
            >
              {t("overview.description")}
            </ContextHelp>
          </div>
        </div>
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="overview-refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6 lg:p-8">
        {query.isPending ? (
          <div
            className="grid gap-3"
            data-testid="overview-loading"
            role="status"
            aria-label={t("common.loading")}
          >
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : query.error || !digest ? (
          <Alert variant="destructive" data-testid="overview-error">
            <AlertTitle>{t("resource.loadFailed", { resource: title })}</AlertTitle>
            <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              data-testid="overview-retry"
              onClick={() => void query.refetch()}
            >
              {t("session.retry")}
            </Button>
          </Alert>
        ) : (
          <div className="grid gap-4">
            {stuck.length > 0 && (
              <Alert variant="destructive" data-testid="overview-incident">
                <AlertTitle>
                  {t("overview.incident.title", { count: String(stuck.length) })}
                </AlertTitle>
                <AlertDescription>
                  {t("overview.incident.description", { days: String(oldestStuckDays) })}
                </AlertDescription>
                <Button variant="outline" size="sm" className="mt-3" asChild>
                  <Link to="/decisions" data-testid="overview-incident-open">
                    {t("overview.incident.open")}
                  </Link>
                </Button>
              </Alert>
            )}

            <Card data-testid="overview-waiting">
              <CardHeader>
                <CardTitle>{t("overview.waiting.title")}</CardTitle>
                <CardDescription>{t("overview.waiting.description")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                {digest.patch_candidates.pending > 0 ? (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span
                        className="text-3xl font-semibold tabular-nums"
                        data-testid="overview-waiting-count"
                      >
                        {digest.patch_candidates.pending}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {t("overview.waiting.pendingLabel")}
                      </span>
                    </div>
                    <div className="grid gap-2" data-testid="overview-waiting-items">
                      {digest.patch_candidates.items.map((item, index) => (
                        <div
                          key={`${item.summary}-${index}`}
                          className="rounded-lg border p-3"
                          data-testid={`overview-waiting-item-${index}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <p className="min-w-0 text-sm font-medium break-words">
                              {item.summary}
                            </p>
                            <Badge
                              variant={item.classification === "safe" ? "secondary" : "destructive"}
                            >
                              {t(
                                item.classification === "safe"
                                  ? "overview.classification.safe"
                                  : "overview.classification.unsafe",
                              )}
                            </Badge>
                          </div>
                          {item.workflow_name && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {item.workflow_name}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                    data-testid="overview-waiting-clear"
                  >
                    <CircleCheck aria-hidden="true" className="shrink-0" />
                    <span>
                      {t("overview.waiting.none")}{" "}
                      {t("overview.waiting.checked", { date: dateTime(digest.generated_at) })}
                    </span>
                  </div>
                )}
              </CardContent>
              {canDecide && (
                <CardFooter>
                  <Button asChild>
                    <Link to="/decisions" data-testid="overview-open-decisions">
                      <ListChecks data-icon="inline-start" />
                      {t("overview.waiting.open")}
                    </Link>
                  </Button>
                </CardFooter>
              )}
            </Card>

            <Card data-testid="overview-failures">
              <CardHeader>
                <CardTitle>{t("operations.failures")}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                {digest.all_clear || failureGroups.length === 0 ? (
                  <div
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                    data-testid="overview-failures-clear"
                  >
                    <CircleCheck aria-hidden="true" className="shrink-0" />
                    <span>{t("overview.failures.allClear")}</span>
                  </div>
                ) : (
                  failureGroups.map((failure, index) => (
                    <div
                      key={`${failure.signature}-${index}`}
                      className="rounded-lg border p-3"
                      data-testid={`overview-failure-${index}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 text-sm font-medium break-words">{failure.cause}</p>
                        <Badge variant="secondary" className="tabular-nums">
                          {failure.count}
                        </Badge>
                      </div>
                      {(failure.workflow_name || failure.guidance) && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {[failure.workflow_name, failure.guidance].filter(Boolean).join(" · ")}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("overview.failures.lastSeen", { date: dateTime(failure.last_seen) })}
                      </p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {digest.risk.length > 0 && (
              <Card data-testid="overview-risks">
                <CardHeader>
                  <CardTitle>{t("operations.risks")}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {digest.risk.map((risk, index) => (
                    <div
                      key={`${risk.headline}-${index}`}
                      className="rounded-lg border p-3"
                      data-testid={`overview-risk-${index}`}
                    >
                      <div className="flex gap-2">
                        <p className="min-w-0 text-sm font-medium break-words">{risk.headline}</p>
                        <Badge variant={risk.severity === "critical" ? "destructive" : "outline"}>
                          {t(
                            risk.severity === "critical" ? "severity.critical" : "severity.warning",
                          )}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{risk.detail}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
