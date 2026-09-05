import { useMutation, useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import {
  type WorkflowPreviewSource,
  workflowPreviewRequest,
  workflowPreviewSucceeded,
} from "@/lib/workflow-preview";
import {
  connectorNameOf,
  type ExecutionStep,
  joinStepsWithLastRun,
  stepResultPreview,
  type WorkflowStepView,
  workflowStepKindKey,
} from "@/lib/workflow-steps";

type Execution = components["schemas"]["Execution"];

interface TestRunResult {
  ok: boolean;
  preview: string;
}

export function WorkflowGallery({
  workflowId,
  versionId,
  steps,
  definition,
  canRun,
}: {
  workflowId: string;
  versionId: string | null;
  steps: readonly unknown[];
  /** The saved definition, replayed as a draft for a whole-workflow test run. */
  definition: Record<string, unknown>;
  canRun: boolean;
}) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<Record<string, TestRunResult>>({});
  const [running, setRunning] = useState<string | null>(null);

  const connectors = useQuery({
    queryKey: ["connectors", "lookup"],
    queryFn: () =>
      apiRequest<{ items: { id: string; display_name: string }[] }>("/v1/connectors?limit=200"),
  });
  const connectorNames = new Map(
    (connectors.data?.items ?? []).map((item) => [item.id, item.display_name]),
  );

  const lastExecution = useQuery({
    queryKey: ["workflow", workflowId, versionId, "last-execution"],
    queryFn: () =>
      apiRequest<{ items: Execution[] }>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&limit=1`,
      ),
  });
  const lastRun = lastExecution.data?.items[0];
  // Evidence belongs to an exact version, not merely to a workflow or step id.
  const executionId = versionId && lastRun?.workflow_version_id === versionId ? lastRun.id : null;
  const runSteps = useQuery({
    queryKey: ["execution", executionId, "steps"],
    enabled: Boolean(executionId),
    queryFn: () =>
      apiRequest<{ items: ExecutionStep[] }>(
        `/v1/executions/${encodeURIComponent(executionId ?? "")}/steps`,
      ),
  });

  const test = useMutation({
    mutationFn: (body: WorkflowPreviewSource) =>
      apiRequest<Record<string, unknown>>("/v1/executions", {
        method: "POST",
        body: JSON.stringify(workflowPreviewRequest(body)),
      }),
  });

  async function runOne(key: string, body: WorkflowPreviewSource): Promise<void> {
    setRunning(key);
    try {
      const result = await test.mutateAsync(body);
      setRuns((current) => ({
        ...current,
        [key]: { ok: workflowPreviewSucceeded(result), preview: JSON.stringify(result, null, 2) },
      }));
    } catch (error) {
      setRuns((current) => ({
        ...current,
        [key]: { ok: false, preview: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      setRunning(null);
    }
  }

  const schedules = useQuery({
    queryKey: ["workflow", workflowId, "schedules"],
    queryFn: () =>
      apiRequest<components["schemas"]["ScheduleListResponse"]>(
        `/v1/schedules?workflow_id=${encodeURIComponent(workflowId)}`,
      ),
  });
  // An entry that names no time is not a schedule anybody can read. The filter
  // used to ask only whether the entry was enabled, so entries without a cron
  // and without a timezone became empty strings and the line read
  // "Läuft automatisch: , , , , , , , , , , , ," — thirteen blanks and a
  // sentence claiming the workflow runs by itself. What survives here is what
  // has something to say.
  const activeSchedules = (schedules.data?.schedules ?? [])
    .filter((entry) => entry.workflow_id === workflowId && !entry.paused)
    .map((entry) => [entry.cron, entry.timezone].filter(Boolean).join(" · "))
    .filter((label) => label.length > 0);

  const views = joinStepsWithLastRun(steps, runSteps.data?.items ?? []);
  const wholeRun = runs.__workflow;

  if (views.length === 0)
    return (
      <p
        className="rounded-xl border p-6 text-sm text-muted-foreground"
        data-testid="workflow-no-steps"
      >
        {t("workflow.noSteps")}
      </p>
    );

  return (
    <div className="grid gap-3" data-testid="workflow-gallery">
      <p className="text-xs text-muted-foreground" data-testid="workflow-schedule">
        {schedules.isPending
          ? t("workflow.scheduleLoading")
          : schedules.isError
            ? t("workflow.scheduleFailed")
            : activeSchedules.length > 0
              ? t("run.schedule", { schedule: activeSchedules.join(", ") })
              : t("run.scheduleNone")}
      </p>
      {canRun && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={running !== null}
            data-testid="workflow-test-run"
            onClick={() => void runOne("__workflow", { source: "draft", definition })}
          >
            <Play data-icon="inline-start" />
            {t(running === "__workflow" ? "workflow.testing" : "workflow.testRun")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("workflow.testRunSecondary")}</span>
        </div>
      )}
      {wholeRun && (
        <pre
          className={`max-h-60 overflow-auto rounded-md border p-2 text-xs ${wholeRun.ok ? "" : "text-destructive"}`}
          data-testid="workflow-test-result"
        >
          {wholeRun.preview}
        </pre>
      )}

      {views.map((view, index) => (
        <StepCard
          key={view.definition.id}
          view={view}
          connectorName={connectorNameOf(view.definition, connectorNames)}
          index={index}
          canRun={canRun}
          running={running === view.definition.id}
          result={runs[view.definition.id] ?? null}
          onTest={() =>
            void runOne(view.definition.id, { source: "step", step: view.definition.raw })
          }
        />
      ))}
    </div>
  );
}

function StepCard({
  view,
  connectorName,
  index,
  canRun,
  running,
  result,
  onTest,
}: {
  view: WorkflowStepView;
  connectorName: string | null;
  index: number;
  canRun: boolean;
  running: boolean;
  result: TestRunResult | null;
  onTest: () => void;
}) {
  const { t } = useI18n();
  const testId = `workflow-step-${index}`;
  const preview = stepResultPreview(view.lastRun);

  return (
    <Card size="sm" data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{view.definition.id}</span>
          {view.definition.kind && (
            <Badge variant="outline">{t(workflowStepKindKey(view.definition.kind))}</Badge>
          )}
          {view.lastRun && (
            <Badge variant="secondary" data-testid={`${testId}-status`}>
              {statusLabel(t, view.lastRun.status)}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("workflow.configuration")}
          </p>
          <dl className="grid gap-1 text-sm">
            {connectorName && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t("nav.connectors")}</dt>
                <dd className="min-w-0 truncate">{connectorName}</dd>
              </div>
            )}
            {view.definition.detail && (
              <div className="min-w-0">
                <dd className="truncate font-mono text-xs">{view.definition.detail}</dd>
              </div>
            )}
          </dl>
        </div>
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("workflow.lastResult")}
          </p>
          {preview ? (
            <pre
              className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-xs"
              data-testid={`${testId}-last-result`}
            >
              {preview}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid={`${testId}-never-ran`}>
              {t("workflow.neverRan")}
            </p>
          )}
          {result && (
            <pre
              className={`mt-2 max-h-40 overflow-auto rounded-md border p-2 text-xs ${result.ok ? "" : "text-destructive"}`}
              data-testid={`${testId}-test-result`}
            >
              {result.preview}
            </pre>
          )}
        </div>
      </CardContent>
      {canRun && (
        <CardContent className="pt-0">
          <Button
            variant="ghost"
            size="sm"
            disabled={running}
            data-testid={`${testId}-test`}
            onClick={onTest}
          >
            <Play data-icon="inline-start" />
            {t(running ? "workflow.testing" : "workflow.testStep")}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
