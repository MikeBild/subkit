import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, workflowHref } from "@/app/links";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import {
  ActionMenu,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  ContextHelp,
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
import { type WorkflowPreviewSource, workflowPreviewRequest } from "@/lib/workflow-preview";
import {
  type BuildVersion,
  buildVersion,
  connectorNameOf,
  type ExecutionStep,
  joinStepsWithLastRun,
  previewSummary,
  type SavedDraft,
  stepEssenceText,
  stepResultPreview,
  type WorkflowStepView,
  workflowStepKindKey,
} from "@/lib/workflow-steps";

type Execution = components["schemas"]["Execution"];

type PreviewResult =
  | { result: Record<string, unknown>; failure: null }
  | { result: null; failure: string };

export function useBuildVersion(
  workflowId: string,
  workflow: {
    current_version_id: string | null;
    current_version: number | null;
    draft_version_id: string | null;
    steps: readonly unknown[];
    definition?: Record<string, unknown> | null;
  },
): BuildVersion {
  const waiting =
    workflow.draft_version_id !== null && workflow.draft_version_id !== workflow.current_version_id;
  const draft = useQuery({
    queryKey: ["workflow-draft-version", workflowId, workflow.draft_version_id],
    enabled: waiting,
    queryFn: () => apiRequest<SavedDraft>(`/v1/workflows/${encodeURIComponent(workflowId)}/draft`),
  });
  return buildVersion(workflow, { data: draft.data, settled: !draft.isPending });
}

const STEP_MARK_KEYS = {
  new: "stepEditor.mark.new",
  changed: "stepEditor.mark.changed",
  moved: "stepEditor.mark.moved",
} as const;

function Copyable({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0" data-action-scope="copy">
      {children}
    </div>
  );
}

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
  useEffect(() => setResults({}), [versionId]);
  const lastExecution = useQuery({
    queryKey: ["workflow", workflowId, versionId, "last-execution"],
    queryFn: () =>
      apiRequest<{ items: Execution[] }>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&limit=1`,
      ),
  });
  const lastRun = lastExecution.data?.items[0];
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
      setResults((current) => ({ ...current, [key]: { result, failure: null } }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [key]: { result: null, failure: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      setRunning(null);
    }
  }
  const clear = useCallback((key: string): void => {
    setResults((current) => {
      if (!(key in current)) return current;
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  }, []);
  return {
    views: joinStepsWithLastRun(steps, runSteps.data?.items ?? []),
    pending: lastExecution.isPending,
    results,
    running,
    runOne,
    clear,
  };
}

export type WorkflowSteps = ReturnType<typeof useWorkflowSteps>;

export function WorkflowTestRun({
  steps,
  definition,
}: {
  steps: WorkflowSteps;
  definition: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const schema = definition.input_schema;
  const properties =
    schema && typeof schema === "object"
      ? (schema as { properties?: Record<string, unknown> }).properties
      : undefined;
  const mode = properties?.mode;
  const options = mode && typeof mode === "object" ? (mode as { enum?: unknown }).enum : undefined;
  const modes =
    Array.isArray(options) &&
    options.length === 2 &&
    options.includes("daily") &&
    options.includes("weekly")
      ? (["daily", "weekly"] as const)
      : null;
  return (
    <span className="flex items-center gap-1">
      <ActionMenu
        label={t("workflow.testRun")}
        testId="workflow-test-run"
        items={(modes ?? [null]).map((selectedMode) => ({
          label: selectedMode
            ? `${t("workflow.testRun")} · ${t(selectedMode === "daily" ? "schedule.daily" : "schedule.weekly")}`
            : t(steps.running === "__workflow" ? "workflow.testing" : "workflow.testRun"),
          disabled: steps.running !== null,
          onSelect: () =>
            void steps.runOne("__workflow", {
              source: "draft",
              definition,
              ...(selectedMode ? { input: { mode: selectedMode } } : {}),
            }),
          testId: selectedMode ? `workflow-test-run-${selectedMode}` : "workflow-test-run",
        }))}
      />
      <ContextHelp label={t("workflow.testRun")} testId="workflow-test-run-help">
        {t("workflow.testRunSecondary")}
      </ContextHelp>
    </span>
  );
}

export function WorkflowTestResult({ steps, visible }: { steps: WorkflowSteps; visible: boolean }) {
  const whole = steps.results.__workflow;
  const { clear } = steps;
  useEffect(() => {
    if (!visible) clear("__workflow");
  }, [visible, clear]);
  if (!whole || !visible) return null;
  return <PreviewCard result={whole} total={steps.views.length} testId="workflow-test-result" />;
}

function PreviewCard({
  result,
  total,
  testId,
}: {
  result: PreviewResult;
  total: number;
  testId: string;
}) {
  const { t } = useI18n();
  const summary = result.result ? previewSummary(result.result, total) : null;
  const facts: Fact[] = summary
    ? [
        {
          label: t("workflow.preview.steps"),
          value: t("workflow.preview.stepsValue", { ran: summary.ran, total: summary.total }),
          testId: `${testId}-steps`,
        },
        ...(summary.held > 0
          ? [
              {
                label: t("workflow.preview.held"),
                value: t(
                  summary.held === 1 ? "workflowPage.steps.one" : "workflowPage.steps.other",
                  {
                    count: summary.held,
                  },
                ),
                testId: `${testId}-held`,
              },
            ]
          : []),
        ...(summary.stoppedAt
          ? [
              {
                label: t("workflow.preview.stoppedAt"),
                value: <span className="font-mono text-xs">{summary.stoppedAt}</span>,
                testId: `${testId}-stopped`,
              },
            ]
          : []),
      ]
    : [];
  const failure = summary ? summary.error : result.failure;
  return (
    <div className="rounded-lg border p-3" data-testid={testId}>
      <Section
        label={t("workflow.preview.title")}
        aside={<StatusBadge state={summary?.status ?? "failed"} testId={`${testId}-status`} />}
      >
        {facts.length > 0 ? <FactList items={facts} /> : null}
        {summary ? (
          <CollapsibleSection label={t("workflow.preview.output")} testId={`${testId}-output`}>
            {summary.output === undefined || summary.output === null ? (
              <p className="text-sm text-muted-foreground">{t("workflow.preview.noOutput")}</p>
            ) : (
              <Copyable>
                <CodeBlock code={JSON.stringify(summary.output, null, 2)} lang="json" />
              </Copyable>
            )}
          </CollapsibleSection>
        ) : null}
        {failure ? (
          <CollapsibleSection label={t("workflow.preview.error")} testId={`${testId}-error`}>
            <Copyable>
              <CodeBlock code={failure} lang="text" />
            </Copyable>
          </CollapsibleSection>
        ) : null}
      </Section>
    </div>
  );
}

export function WorkflowStepsList({
  steps,
  workflowName,
  canRun,
  editor,
  emptyAction,
}: {
  steps: WorkflowSteps;
  workflowName?: string;
  canRun: boolean;
  editor?: StepDraft;
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
                    label={t("stepEditor.actionsFor", { step: row.view.definition.id })}
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
          workflowName={workflowName}
          view={selected}
          index={open}
          connectorName={connectorNameOf(selected.definition, connectorNames)}
          canRun={canRun}
          steps={steps}
          onClose={() => setOpen(null)}
          {...(editor
            ? {
                onEdit: () => {
                  setOpen(null);
                  setEditing(open);
                },
              }
            : {})}
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

function StepSheet({
  view,
  workflowName,
  index,
  connectorName,
  canRun,
  steps,
  onClose,
  onEdit,
}: {
  view: WorkflowStepView;
  workflowName?: string;
  index: number;
  connectorName: string | null;
  canRun: boolean;
  steps: WorkflowSteps;
  onClose: () => void;
  onEdit?: () => void;
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
      dock
      open
      onOpenChange={(next) => !next && onClose()}
      title={t("workflowSteps.sheetTitle", { number: index + 1, name: definition.id })}
      subtitle={workflowName}
      badge={lastRun ? <StatusBadge state={lastRun.status} /> : undefined}
      menu={
        onEdit ? (
          <ActionMenu
            items={[
              { label: t("stepEditor.edit"), onSelect: onEdit, testId: `${testId}-sheet-edit` },
            ]}
          />
        ) : undefined
      }
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
      {result ? <PreviewCard result={result} total={1} testId={`${testId}-test-result`} /> : null}
    </RecordSheet>
  );
}
