import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, ListChecks, RefreshCw } from "lucide-react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { canSeeDecisions, useDecisionQueue } from "@/app/use-decisions";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
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
import { statusLabel } from "@/lib/status-label";
import { bannerSubset } from "./decisions-model";
import type { FailureGroup, HealthDigest } from "./overview-model";
import { partitionFailures, recentRuns } from "./overview-model";

type Execution = components["schemas"]["Execution"];

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
  // `stats:read` does not imply `execution:read`, so the recent-runs block is
  // gated on its own permission rather than on the page's.
  const canSeeRuns = session.permissions.includes("execution:read");
  const runsQuery = useQuery({
    queryKey: ["overview", "recent-runs"],
    enabled: canSeeRuns,
    staleTime: 30_000,
    queryFn: () => apiRequest<{ items: Execution[] }>("/v1/executions?limit=8"),
  });
  // The waiting numbers come from the decision queue, never from the digest:
  // the digest knows only patch candidates, so anything it said about "how many
  // are waiting" was a third of the answer presented as the whole. The digest
  // keeps what it does own — failure groups, risks and the all-clear.
  const queue = useDecisionQueue(session.permissions);
  const digest = query.data;
  const { incidents, trials } = partitionFailures(digest?.failure_groups ?? []);
  const open = queue.open;
  const banner = open ? bannerSubset(open) : null;
  const recent = recentRuns(runsQuery.data?.items ?? []);

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
    <PageFrame
      testId="overview-page"
      title={title}
      description={t("overview.description")}
      scroll="page"
      action={
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="overview-refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      }
    >
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
          {open !== null && banner !== null && banner.mode !== "none" && (
            <Alert variant="destructive" data-testid="overview-incident">
              <AlertTitle>
                {/* The subset is named, not implied: the banner used to show one
                    number and Zone A another, and nothing on the page said how
                    the two were related. The data attributes carry the same two
                    numbers the sentence states. */}
                <span
                  data-testid="incident-decisions-count"
                  data-subset={String(banner.count)}
                  data-subset-total={String(banner.total)}
                >
                  {t(
                    banner.mode === "all"
                      ? "overview.incident.all"
                      : banner.mode === "atLeast"
                        ? "overview.incident.atLeast"
                        : "overview.incident.subset",
                    { count: String(banner.count), total: String(banner.total) },
                  )}
                </span>
              </AlertTitle>
              <AlertDescription>
                {t("overview.incident.description", { days: String(open.oldestAgeDays) })}
              </AlertDescription>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <Link to="/decisions" data-testid="overview-incident-open">
                  {t("overview.incident.open")}
                </Link>
              </Button>
            </Alert>
          )}

          {/* Zone A. This used to render the full candidate list a second
                time — the same rows as /decisions, not decidable here, and
                titled from a different field, so the two pages disagreed about
                what one candidate was called. A count and a link cannot
                disagree with anything. */}
          <Card data-testid="overview-waiting">
            <CardHeader>
              <CardTitle>{t("overview.waiting.title")}</CardTitle>
              <CardDescription>{t("overview.waiting.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              {open !== null && open.total > 0 ? (
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span data-testid="zone-a-decisions-count">
                    <span
                      className="text-3xl font-semibold tabular-nums"
                      data-testid="overview-waiting-count"
                    >
                      {open.total}
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t("overview.waiting.pendingLabel")}
                  </span>
                  {open.oldestAgeDays > 0 && (
                    <span
                      className="text-sm text-muted-foreground"
                      data-testid="overview-waiting-oldest"
                    >
                      {t("overview.waiting.oldest", { days: String(open.oldestAgeDays) })}
                    </span>
                  )}
                </div>
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
            {canDecide && open !== null && open.total > 0 && (
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
              {digest.all_clear || (incidents.length === 0 && trials.length === 0) ? (
                <div
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  data-testid="overview-failures-clear"
                >
                  <CircleCheck aria-hidden="true" className="shrink-0" />
                  <span>{t("overview.failures.allClear")}</span>
                </div>
              ) : (
                <>
                  {incidents.map((failure, index) => (
                    <FailureRow
                      key={`${failure.signature}-${index}`}
                      failure={failure}
                      testId={`overview-failure-${index}`}
                      dateTime={dateTime}
                      lastSeenLabel={t("overview.failures.lastSeen", {
                        date: dateTime(failure.last_seen),
                      })}
                    />
                  ))}
                  {/* Trial runs sit under their own heading. A person building
                        a workflow can fail two dozen runs in an afternoon, and
                        counting those as incidents reports a crisis that is not
                        happening. */}
                  {trials.length > 0 && (
                    <div className="mt-2 grid gap-2 border-t pt-3" data-testid="overview-trials">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("overview.failures.fromTrials")}
                      </p>
                      {trials.map((failure, index) => (
                        <FailureRow
                          key={`${failure.signature}-${index}`}
                          failure={failure}
                          testId={`overview-trial-${index}`}
                          dateTime={dateTime}
                          lastSeenLabel={t("overview.failures.lastSeen", {
                            date: dateTime(failure.last_seen),
                          })}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {canSeeRuns && (
            <Card data-testid="overview-recent">
              <CardHeader>
                <CardTitle>{t("overview.recent.title")}</CardTitle>
                <CardDescription>{t("overview.recent.description")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="overview-recent-empty">
                    {t("overview.recent.empty")}
                  </p>
                ) : (
                  recent.map((run, index) => (
                    <div
                      key={run.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-3"
                      data-testid={`overview-recent-${index}`}
                    >
                      <span className="min-w-0 truncate text-sm font-medium">
                        {run.name ?? t("overview.recent.unnamed")}
                      </span>
                      <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                        <Badge variant="secondary">{statusLabel(t, run.status)}</Badge>
                        {run.startedAt ? dateTime(run.startedAt) : "—"}
                        <span className="tabular-nums">
                          {run.durationMs === null
                            ? "—"
                            : t("overview.recent.duration", {
                                seconds: String(Math.round(run.durationMs / 1000)),
                              })}
                        </span>
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )}

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
                        {t(risk.severity === "critical" ? "severity.critical" : "severity.warning")}
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
    </PageFrame>
  );
}

/** One root-cause group. Shared by the incident list and the trial list so the
 *  two can never drift into different shapes. */
function FailureRow({
  failure,
  testId,
  lastSeenLabel,
}: {
  failure: FailureGroup;
  testId: string;
  dateTime: (value: string) => string;
  lastSeenLabel: string;
}) {
  return (
    <div className="rounded-lg border p-3" data-testid={testId}>
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
      <p className="mt-1 text-xs text-muted-foreground">{lastSeenLabel}</p>
    </div>
  );
}
