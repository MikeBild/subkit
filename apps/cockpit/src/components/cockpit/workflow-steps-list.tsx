import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, workflowHref } from "@/app/links";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import {
  ActionMenu,
  type CockpitColumn,
  CodeBlock,
  type Fact,
  FactList,
  RecordSheet,
  Section,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { tableColumns } from "@/components/cockpit/table-columns";
import { StepDialog, type StepDraft, stepId } from "@/components/cockpit/workflow-step-editor";
import { useI18n } from "@/lib/i18n-context";
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

const STEP_MARK_KEYS = {
  new: "stepEditor.mark.new",
  changed: "stepEditor.mark.changed",
  moved: "stepEditor.mark.moved",
} as const;

/** One copy action per block: the same "Kopieren" beside two blocks is two acts. */
function Copyable({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0" data-action-scope="copy">
      {children}
    </div>
  );
}

/**
 * The saved steps and their previews. One hook for the table and the sheet,
 * so a preview started in a step's sheet is the same press as anywhere else.
 */
export function useWorkflowSteps({
  workflowId,
  versionId,
  steps,
}: {
  workflowId: string;
  versionId: string | null;
  steps: readonly unknown[];
}) {
  const [results, setResults] = useState<Record<string, PreviewResult>>({});
  const [running, setRunning] = useState<string | null>(null);
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
  return {
    views: joinStepsWithLastRun(steps, runSteps.data?.items ?? []),
    pending: lastExecution.isPending,
    results,
    running,
    runOne,
  };
}

export type WorkflowSteps = ReturnType<typeof useWorkflowSteps>;

/** "Testlauf": the whole saved workflow as a preview without effects, and its result. */
export function WorkflowTestRun({
  steps,
  definition,
}: {
  steps: WorkflowSteps;
  definition: Record<string, unknown>;
}) {
  const { t } = useI18n();
  return (
    <ActionMenu
      items={[
        {
          label: t(steps.running === "__workflow" ? "workflow.testing" : "workflow.testRun"),
          disabled: steps.running !== null,
          onSelect: () => void steps.runOne("__workflow", { source: "draft", definition }),
          testId: "workflow-test-run",
        },
      ]}
    />
  );
}

export function WorkflowTestResult({ steps }: { steps: WorkflowSteps }) {
  const { t } = useI18n();
  const whole = steps.results.__workflow;
  if (!whole) return null;
  return (
    <Copyable>
      <CodeBlock
        label={t(whole.ok ? "workflow.testRun" : "workflowSteps.testFailed")}
        code={whole.preview}
        lang="json"
        testId="workflow-test-result"
      />
    </Copyable>
  );
}

/**
 * The saved steps as one table (V4c): number, id, kind, what it does and how
 * it last ended. A row opens the step's sheet with its whole configuration,
 * its last result and its own preview.
 */
export function WorkflowStepsList({
  steps,
  canRun,
  editor,
  emptyAction,
}: {
  steps: WorkflowSteps;
  canRun: boolean;
  /** The step editor (R16), for a reader who may change the workflow. */
  editor?: StepDraft;
  /** "Schritt hinzufügen", where there is no step yet. */
  emptyAction?: ReactNode;
}) {
  const { t, dateTime } = useI18n();
  const connectorNames = useConnectorNames();
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const rows = steps.views.map((view, index) => ({ view, index }));
  const columns = useMemo<CockpitColumn<{ view: WorkflowStepView; index: number }>[]>(() => {
    const column = tableColumns<{ view: WorkflowStepView; index: number }>({ t, dateTime });
    return [
      column.custom(
        "id",
        (row) => row.view.definition.id,
        t("workflowSteps.column.step"),
        (row) => (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {row.index + 1}
            </span>
            <span className="min-w-0 truncate font-mono text-xs font-medium">
              {row.view.definition.id}
            </span>
            {editor?.marks[row.view.definition.id] ? (
              <span
                className="shrink-0 text-xs text-muted-foreground"
                data-testid={`workflow-step-${row.index}-mark`}
              >
                {t(STEP_MARK_KEYS[editor.marks[row.view.definition.id] ?? "changed"])}
              </span>
            ) : null}
          </span>
        ),
        { width: "w-[26%]" },
      ),
      column.custom(
        "kind",
        (row) => row.view.definition.kind,
        t("workflowSteps.column.kind"),
        (row) => t(workflowStepKindKey(row.view.definition.kind)),
        { width: "w-[16%]" },
      ),
      column.custom(
        "essence",
        (row) => row.index,
        t("workflowSteps.column.does"),
        (row) => (
          <span className="block truncate" data-testid={`workflow-step-${row.index}-essence`}>
            {stepEssenceText(row.view.definition, t, {
              connector: connectorNameOf(row.view.definition, connectorNames),
            })}
          </span>
        ),
        { width: "w-[38%]" },
      ),
      column.custom(
        "last",
        (row) => row.view.lastRun?.status ?? null,
        t("workflowSteps.column.last"),
        (row) =>
          row.view.lastRun ? (
            <StatusBadge
              state={row.view.lastRun.status}
              testId={`workflow-step-${row.index}-status`}
            />
          ) : (
            <span
              className="text-xs text-muted-foreground"
              data-testid={`workflow-step-${row.index}-never-ran`}
            >
              {t("workflow.neverRanShort")}
            </span>
          ),
        { width: "w-[20%]" },
      ),
    ];
  }, [t, dateTime, connectorNames, editor?.marks]);
  const selected = open === null ? null : (steps.views[open] ?? null);
  return (
    <div data-testid="workflow-steps">
      <RecordTable
        columns={columns}
        data={rows}
        collectionId="workflow-step-list"
        emptyLine={t("workflow.noSteps")}
        emptyAction={emptyAction}
        pending={steps.pending && steps.views.length === 0}
        onOpen={(row) => setOpen(row.index)}
        rowLabel={(row) => t("workflow.step", { count: row.index + 1 })}
        rowActions={
          editor
            ? (row) => (
                <span data-action-scope="step">
                  <ActionMenu
                    testId={`workflow-step-${row.index}-menu`}
                    items={[
                      {
                        label: t("stepEditor.edit"),
                        onSelect: () => setEditing(row.index),
                        testId: `workflow-step-${row.index}-edit`,
                      },
                      ...(row.index > 0
                        ? [
                            {
                              label: t("stepEditor.up"),
                              onSelect: () => editor.move(row.index, -1),
                              testId: `workflow-step-${row.index}-up`,
                            },
                          ]
                        : []),
                      ...(row.index < steps.views.length - 1
                        ? [
                            {
                              label: t("stepEditor.down"),
                              onSelect: () => editor.move(row.index, 1),
                              testId: `workflow-step-${row.index}-down`,
                            },
                          ]
                        : []),
                      {
                        label: t("stepEditor.remove"),
                        onSelect: () => editor.remove(row.index),
                        destructive: true,
                        testId: `workflow-step-${row.index}-remove`,
                      },
                    ]}
                  />
                </span>
              )
            : undefined
        }
      />
      {selected && open !== null ? (
        <StepSheet
          view={selected}
          index={open}
          connectorName={connectorNameOf(selected.definition, connectorNames)}
          canRun={canRun}
          steps={steps}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {editor && editing !== null ? (
        <StepDialog
          open
          onOpenChange={(next) => !next && setEditing(null)}
          step={editor.steps[editing]}
          taken={editor.steps.filter((_, at) => at !== editing).map(stepId)}
          onApply={(step) => editor.replace(editing, step)}
        />
      ) : null}
    </div>
  );
}

/** One step (O6): what it is configured with, how it last ended, and its own preview. */
function StepSheet({
  view,
  index,
  connectorName,
  canRun,
  steps,
  onClose,
}: {
  view: WorkflowStepView;
  index: number;
  connectorName: string | null;
  canRun: boolean;
  steps: WorkflowSteps;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const testId = `workflow-step-${index}`;
  const { definition, lastRun } = view;
  const lastResult = stepResultPreview(lastRun);
  const called = definition.essence.kind === "call" ? definition.essence : null;
  const result = steps.results[definition.id] ?? null;
  const running = steps.running === definition.id;
  const facts: Fact[] = [
    { label: t("workflowSteps.column.kind"), value: t(workflowStepKindKey(definition.kind)) },
    ...(connectorName ? [{ label: t("authority.connector"), value: connectorName }] : []),
    ...(called?.workflowId
      ? [
          {
            label: t("workflow.fact.calls"),
            value: (
              <a
                href={absolute(workflowHref(called.workflowId))}
                className="underline underline-offset-4"
                data-testid={`${testId}-called-workflow`}
              >
                {called.slug ?? t("workflow.fact.callsOpen")}
              </a>
            ),
          },
        ]
      : []),
    ...definition.facts.map((fact) => ({
      label: t(fact.labelKey),
      value: "valueKey" in fact ? t(fact.valueKey) : fact.value,
    })),
  ];
  return (
    <RecordSheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={<span className="font-mono">{definition.id}</span>}
      badge={lastRun ? <StatusBadge state={lastRun.status} /> : undefined}
      action={
        canRun ? (
          <ActionMenu
            items={[
              {
                label: t(running ? "workflow.testing" : "workflow.testStep"),
                disabled: steps.running !== null,
                onSelect: () =>
                  void steps.runOne(definition.id, { source: "step", step: definition.raw }),
                testId: `${testId}-test`,
              },
            ]}
          />
        ) : undefined
      }
      testId={`${testId}-sheet`}
      closeTestId={`${testId}-close`}
    >
      <div className="flex flex-col gap-3" data-testid={`${testId}-configuration`}>
        <FactList items={facts} />
        {definition.blocks.map((block, blockIndex) => (
          <Copyable key={`${block.labelKey}:${blockIndex}`}>
            <CodeBlock
              label={t(block.labelKey)}
              code={block.code}
              lang={block.language}
              testId={`${testId}-block-${blockIndex}`}
            />
          </Copyable>
        ))}
        {facts.length <= 1 && definition.blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("workflow.noConfiguration")}</p>
        ) : null}
      </div>
      <Section label={t("workflow.lastResult")}>
        {lastResult ? (
          <Copyable>
            <CodeBlock code={lastResult} lang="json" testId={`${testId}-last-result`} />
          </Copyable>
        ) : (
          <p className="text-sm text-muted-foreground">{t("workflow.neverRan")}</p>
        )}
      </Section>
      {result ? (
        <Copyable>
          <CodeBlock
            label={t(result.ok ? "workflow.testStep" : "workflowSteps.testFailed")}
            code={result.preview}
            lang="json"
            testId={`${testId}-test-result`}
          />
        </Copyable>
      ) : null}
    </RecordSheet>
  );
}
