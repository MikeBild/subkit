import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, runHref, runsHref } from "@/app/links";
import { CauseFix } from "@/components/cockpit/cause-fix";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { causeClassLabel } from "@/lib/cause-class";
import { type ConnectorAuthInput, connectorAuthState } from "@/lib/connector-auth-state";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { remedyFor } from "@/lib/remedy";
import { refusedSignIn } from "@/lib/run-availability";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";
import { isExecutionRecord, latestFailedRun, stepConnectorId } from "@/pages/runs-model";

type ExecutionList = components["schemas"]["ExecutionListResponse"];
type ExecutionStepList = components["schemas"]["ExecutionStepListResponse"];
type ExecutionListItem = components["schemas"]["ExecutionListItem"];

/**
 * Only what is a run. A 200 that carries something else — a proxy's page, a
 * partial row — must not reach the status label, where a missing `status`
 * took the whole page down instead of leaving one line out.
 */
function runsOf(list: ExecutionList | undefined): ExecutionListItem[] {
  return (list?.items ?? []).filter((item): item is ExecutionListItem => isExecutionRecord(item));
}

/** A workflow's health, beside its name: a dot and the word, never colour alone. */
export function WorkflowHealthBadge({ state }: { state: string | null }) {
  const { t } = useI18n();
  if (!state) return null;
  const tone =
    state === "ok" ? "bg-success" : state === "degraded" ? "bg-destructive" : "bg-warning";
  return (
    <Badge variant="outline" className="gap-1.5" data-testid="workflow-health-badge">
      <span aria-hidden="true" className={cn("size-2 rounded-full", tone)} />
      {statusLabel(t, state)}
    </Badge>
  );
}

/**
 * Why this workflow is unhealthy and what to do — on its own page.
 *
 * The cause is the cockpit's sentence, built from the newest failed run's
 * classified failure. The engine's `health_reason` is free text in whatever
 * language the engine wrote, so it stands on the "Wortlaut der Engine" line
 * and is never passed off as the cockpit's own words.
 *
 * The remedy stands here and nowhere else on the page — and not here either
 * where the automation panel below already carries it: an action has one
 * trigger per view.
 */
export function WorkflowCause({
  workflowId,
  healthState,
  healthReason,
  healthChangedAt,
  permissions,
  panelOffers,
}: {
  workflowId: string;
  healthState: string | null;
  healthReason: string | null;
  healthChangedAt: string | null;
  permissions: readonly string[];
  /** The remedies the automation panel on the same page carries itself. */
  panelOffers: { reviewRepair: boolean; chat: boolean };
}) {
  const { t, locale } = useI18n();
  const unhealthy = Boolean(healthState) && healthState !== "ok";
  const canReadRuns = permissions.includes("execution:read");
  const latestFailed = useQuery({
    queryKey: ["workflow-latest-failed-run", workflowId],
    enabled: unhealthy && canReadRuns,
    // The list filters by ONE status, and the engine counts three as failed
    // (failed, timed_out, aborted). Asking for `failed` alone skipped a
    // workflow whose newest failure was a timeout and named an older cause.
    queryFn: () =>
      apiRequest<ExecutionList>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&limit=20`,
      ),
  });
  const failedRun = latestFailedRun(runsOf(latestFailed.data));
  const failure = failedRun?.failure ?? null;
  // A rejected sign-in names no connector on the list row; the run's steps do.
  const failedSteps = useQuery({
    queryKey: ["run-steps", failedRun?.id ?? ""],
    enabled: failure?.cause_class === "auth_failed" && Boolean(failedRun),
    queryFn: () =>
      apiRequest<ExecutionStepList>(
        `/v1/executions/${encodeURIComponent(failedRun?.id ?? "")}/steps`,
      ),
  });
  const patch = useQuery({
    queryKey: ["run-open-repair", workflowId],
    enabled: unhealthy && permissions.includes("workflow:read"),
    queryFn: () =>
      apiRequest<{ items: { id: string }[] }>(
        `/v1/patch-candidates?status=proposed&workflow_id=${encodeURIComponent(workflowId)}&limit=1`,
      ),
  });
  const stoppingStep =
    failedSteps.data?.items?.find((step) => step.step_key === failure?.step_key) ?? null;
  const connectorId = stepConnectorId(stoppingStep);
  // Where the sign-in really stands, as the connector reports it.
  const connector = useQuery({
    queryKey: ["connector", connectorId ?? ""],
    enabled: connectorId !== null && permissions.includes("connector:read"),
    queryFn: () =>
      apiRequest<ConnectorAuthInput>(`/v1/connectors/${encodeURIComponent(connectorId ?? "")}`),
  });
  if (!unhealthy || !healthState) return null;
  const cause = failure?.cause_class && failure.cause_class !== "ok" ? failure.cause_class : null;
  const causeLabel = cause ? causeClassLabel(cause, t) : null;
  const SLOT = "\u0000";
  const sentence = causeLabel
    ? failure?.step_key
      ? t("detail.cause.atStep", { step: failure.step_key, cause: SLOT })
      : t("detail.cause.class", { cause: SLOT })
    : t("detail.cause.noRun", { state: statusLabel(t, healthState) });
  const [lead, tail = ""] = sentence.split(SLOT);
  // "The approval no longer fits" is the automation panel's to resolve: it
  // stands directly below, says the state and carries the act — approving
  // again, or the repair its diagnosis names. This block then says the cause
  // and offers nothing. For every other cause it offers its remedy unless the
  // panel already does: the filed repairs are reviewed in one sheet, and one
  // conversation changes the workflow.
  const ownedByPanel = cause === "authority_mismatch";
  const remedy = ownedByPanel
    ? null
    : remedyFor({
        workflowId,
        executionId: failedRun?.id ?? null,
        patch: panelOffers.reviewRepair ? null : (patch.data?.items?.[0] ?? null),
        // A run refused for its connector ran no step; the list row carries the
        // connector the refusal named.
        authState: connectorId
          ? {
              connectorId,
              state:
                connector.data && typeof connector.data === "object"
                  ? connectorAuthState(connector.data)
                  : "unproven",
            }
          : cause === "connector_unavailable"
            ? refusedSignIn(failure?.connector)
            : null,
        canRun: permissions.includes("workflow:run"),
        canChat: permissions.includes("conversation:write") && !panelOffers.chat,
        prompt: t("remedy.chatPrompt"),
      });
  const more = canReadRuns
    ? [
        {
          label: t("detail.failedRuns"),
          href: runsHref({ workflowId, status: "failed" }),
        },
      ]
    : [];
  return (
    <CauseFix
      testId="workflow-cause"
      status={{
        tone: healthState === "degraded" ? "critical" : "warning",
        label: t("workflows.health", { state: statusLabel(t, healthState) }),
      }}
      since={healthChangedAt ? formatRelativeTime(locale, healthChangedAt) : null}
      cause={
        <>
          {lead}
          {causeLabel ? <LabelText label={causeLabel} /> : null}
          {tail}
          <RefusalReasonLine
            reason={failure?.refusal_reason}
            testId="workflow-cause-refusal-reason"
            className="mt-1 block"
          />
        </>
      }
      guidance={healthReason}
      remedy={remedy ? { label: t(remedy.labelKey), href: remedy.href } : null}
      // The page's one filled action is "Ausführen".
      remedyVariant="outline"
      more={more}
    />
  );
}

/**
 * The five newest runs of this workflow, each leading to its own sheet, and
 * the way to all of them. A property of the current workflow — how it has been
 * doing — not a history stream (§0): the full log lives on the runs page.
 */
export function RecentRuns({ workflowId }: { workflowId: string }) {
  const { t, dateTime } = useI18n();
  const query = useQuery({
    queryKey: ["workflow-recent-runs", workflowId],
    queryFn: () =>
      apiRequest<ExecutionList>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&limit=5`,
      ),
  });
  const view = queryView(query, (data) => runsOf(data).length === 0);
  return (
    <section className="grid gap-2" data-testid="workflow-recent-runs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("detail.recentRuns")}</h2>
        <a
          href={absolute(runsHref({ workflowId }))}
          className="text-sm underline underline-offset-4"
          data-testid="workflow-all-runs"
        >
          {t("detail.allRuns")}
        </a>
      </div>
      {view === "loading" ? (
        <Skeleton className="h-24 w-full" />
      ) : view === "error" ? (
        <LoadFailed
          title={t("runs.detail.loadFailed")}
          onRetry={() => void query.refetch()}
          testId="workflow-recent-runs-failed"
        />
      ) : view === "empty" ? (
        <p className="text-sm text-muted-foreground" data-testid="workflow-recent-runs-empty">
          {t("detail.noRuns")}
        </p>
      ) : (
        <ul className="grid gap-1">
          {runsOf(query.data).map((run, index) => {
            const cause = run.failure?.cause_class;
            return (
              <li key={run.id}>
                <a
                  href={absolute(runHref(run.id))}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                  data-testid={`workflow-recent-run-${index}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline">{statusLabel(t, run.status)}</Badge>
                    {cause && cause !== "ok" ? (
                      <span className="min-w-0 truncate text-muted-foreground">
                        <LabelText label={causeClassLabel(cause, t)} />
                        <RefusalReasonLine
                          reason={run.failure?.refusal_reason}
                          testId={`workflow-recent-run-${index}-refusal-reason`}
                          className="inline before:content-['_·_']"
                        />
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dateTime(run.started_at ?? run.created_at)}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
