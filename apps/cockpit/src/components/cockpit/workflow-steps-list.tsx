import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, workflowHref } from "@/app/links";
import { ContextHelp } from "@/components/cockpit/context-help";
import { FencedBlock } from "@/components/cockpit/fenced-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  stepEssenceText,
  stepResultPreview,
  type WorkflowStepView,
  workflowStepKindKey,
} from "@/lib/workflow-steps";

type Execution = components["schemas"]["Execution"];

interface PreviewResult {
  ok: boolean;
  preview: string;
}

/**
 * "Schritte": the saved steps, one compact row each — its number, its id, what
 * kind it is, one line on what it does and how it last ended. Opening a row
 * shows the whole configuration, the last result and the step's own preview.
 */
export function WorkflowStepsList({
  workflowId,
  versionId,
  steps,
  definition,
  canRun,
}: {
  workflowId: string;
  versionId: string | null;
  steps: readonly unknown[];
  /** The saved definition, replayed as a draft for a whole-workflow preview. */
  definition: Record<string, unknown>;
  canRun: boolean;
}) {
  const { t } = useI18n();
  const [results, setResults] = useState<Record<string, PreviewResult>>({});
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

  const preview = useMutation({
    mutationFn: (body: WorkflowPreviewSource) =>
      apiRequest<Record<string, unknown>>("/v1/executions", {
        method: "POST",
        body: JSON.stringify(workflowPreviewRequest(body)),
      }),
  });

  async function runOne(key: string, body: WorkflowPreviewSource): Promise<void> {
    setRunning(key);
    try {
      const result = await preview.mutateAsync(body);
      setResults((current) => ({
        ...current,
        [key]: { ok: workflowPreviewSucceeded(result), preview: JSON.stringify(result, null, 2) },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [key]: { ok: false, preview: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      setRunning(null);
    }
  }

  const views = joinStepsWithLastRun(steps, runSteps.data?.items ?? []);
  const whole = results.__workflow;

  return (
    <section className="grid min-w-0 gap-2" data-testid="workflow-steps">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t("workflow.stepsTitle", { count: views.length })}
        </h2>
        {canRun && views.length > 0 ? (
          <div className="flex items-center gap-1">
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
            <ContextHelp label={t("workflow.testRunHelp.label")} testId="workflow-test-run-help">
              {t("workflow.testRunSecondary")}
            </ContextHelp>
          </div>
        ) : null}
      </div>
      {whole ? (
        <pre
          className={`max-h-60 overflow-auto rounded-md border p-2 text-xs ${whole.ok ? "" : "text-destructive"}`}
          data-testid="workflow-test-result"
        >
          {whole.preview}
        </pre>
      ) : null}
      {views.length === 0 ? (
        <p
          className="rounded-xl border p-4 text-sm text-muted-foreground"
          data-testid="workflow-no-steps"
        >
          {t("workflow.noSteps")}
        </p>
      ) : (
        <ol className="grid min-w-0 divide-y rounded-xl border" data-testid="workflow-step-list">
          {views.map((view, index) => (
            <StepRow
              key={view.definition.id}
              view={view}
              connectorName={connectorNameOf(view.definition, connectorNames)}
              index={index}
              canRun={canRun}
              running={running === view.definition.id}
              busy={running !== null}
              result={results[view.definition.id] ?? null}
              onPreview={() =>
                void runOne(view.definition.id, { source: "step", step: view.definition.raw })
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function StepRow({
  view,
  connectorName,
  index,
  canRun,
  running,
  busy,
  result,
  onPreview,
}: {
  view: WorkflowStepView;
  connectorName: string | null;
  index: number;
  canRun: boolean;
  running: boolean;
  busy: boolean;
  result: PreviewResult | null;
  onPreview: () => void;
}) {
  const { t } = useI18n();
  const testId = `workflow-step-${index}`;
  const { definition, lastRun } = view;
  const essence = stepEssenceText(definition, t, { connector: connectorName });
  const lastResult = stepResultPreview(lastRun);
  const called = definition.essence.kind === "call" ? definition.essence : null;

  return (
    <li className="min-w-0" data-testid={testId}>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
            data-testid={`${testId}-toggle`}
          >
            <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="grid min-w-0 flex-1 gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,12rem)_minmax(0,9rem)_minmax(0,1fr)] sm:items-baseline">
              <span className="min-w-0 truncate font-mono text-xs font-medium">
                {definition.id}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                {t(workflowStepKindKey(definition.kind))}
              </span>
              <span className="min-w-0 truncate" data-testid={`${testId}-essence`}>
                {essence}
              </span>
            </span>
            {lastRun ? (
              <Badge variant="secondary" className="shrink-0" data-testid={`${testId}-status`}>
                {statusLabel(t, lastRun.status)}
              </Badge>
            ) : (
              <span
                className="shrink-0 text-xs text-muted-foreground"
                data-testid={`${testId}-never-ran`}
              >
                {t("workflow.neverRanShort")}
              </span>
            )}
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid min-w-0 gap-3 border-t bg-muted/20 p-3 lg:grid-cols-2">
            <div
              className="grid min-w-0 content-start gap-2"
              data-testid={`${testId}-configuration`}
            >
              <p className="text-xs font-medium text-muted-foreground">
                {t("workflow.configuration")}
              </p>
              {connectorName || definition.facts.length > 0 || called?.workflowId ? (
                <dl className="grid gap-1 text-sm">
                  {connectorName ? (
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">{t("authority.connector")}</dt>
                      <dd className="min-w-0 truncate">{connectorName}</dd>
                    </div>
                  ) : null}
                  {called?.workflowId ? (
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">{t("workflow.fact.calls")}</dt>
                      <dd className="min-w-0 truncate">
                        <a
                          href={absolute(workflowHref(called.workflowId))}
                          className="underline underline-offset-4"
                          data-testid={`${testId}-called-workflow`}
                        >
                          {called.slug ?? t("workflow.fact.callsOpen")}
                        </a>
                      </dd>
                    </div>
                  ) : null}
                  {definition.facts.map((fact) => (
                    <div key={fact.labelKey} className="flex gap-2">
                      <dt className="text-muted-foreground">{t(fact.labelKey)}</dt>
                      <dd className="min-w-0 truncate">
                        {"valueKey" in fact ? t(fact.valueKey) : fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {definition.blocks.map((block, blockIndex) => (
                <FencedBlock
                  key={`${block.labelKey}:${blockIndex}`}
                  label={t(block.labelKey)}
                  code={block.code}
                  language={block.language}
                  testId={`${testId}-block-${blockIndex}`}
                />
              ))}
              {!connectorName &&
              definition.facts.length === 0 &&
              definition.blocks.length === 0 &&
              !called?.workflowId ? (
                <p className="text-sm text-muted-foreground">{t("workflow.noConfiguration")}</p>
              ) : null}
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("workflow.lastResult")}
              </p>
              {lastResult ? (
                <pre
                  className="max-h-60 overflow-auto rounded-md border bg-background p-2 text-xs"
                  data-testid={`${testId}-last-result`}
                >
                  {lastResult}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">{t("workflow.neverRan")}</p>
              )}
              {canRun ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 w-fit"
                  disabled={busy}
                  data-testid={`${testId}-test`}
                  onClick={onPreview}
                >
                  <Play data-icon="inline-start" />
                  {t(running ? "workflow.testing" : "workflow.testStep")}
                </Button>
              ) : null}
              {result ? (
                <pre
                  className={`max-h-60 overflow-auto rounded-md border bg-background p-2 text-xs ${result.ok ? "" : "text-destructive"}`}
                  data-testid={`${testId}-test-result`}
                >
                  {result.preview}
                </pre>
              ) : null}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
