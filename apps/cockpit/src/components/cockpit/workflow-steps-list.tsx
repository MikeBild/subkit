import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  Bell,
  Bot,
  CalendarClock,
  ChevronRight,
  Clock,
  Code,
  Flag,
  GitBranch,
  Hand,
  type LucideIcon,
  Plug,
  Plus,
  Repeat,
  Shuffle,
  Split,
  Webhook,
  Workflow,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/api/client";
import { absolute, connectorHref, workflowHref } from "@/app/links";
import {
  type ConnectorRecord,
  connectorService,
  useConnectorRecords,
} from "@/components/cockpit/connector-names";
import {
  ActionButton,
  ActionMenu,
  type ActionMenuItem,
  CodeBlock,
  ContextHelp,
  type Fact,
  FactList,
  RecordSheet,
  Section,
  STATUS_DOT,
  StatusBadge,
  statusTone,
  TechnicalDetails,
} from "@/components/cockpit/patterns";
import { ServiceIcon } from "@/components/cockpit/service-icon";
import { StepDialog, type StepDraft, stepId } from "@/components/cockpit/workflow-step-editor";
import {
  CONNECTOR_STRIP_KEYS,
  type ConnectorStrip,
  connectorRecordStrip,
} from "@/lib/connector-strip";
import { useI18n } from "@/lib/i18n-context";
import type { ServiceIdentity } from "@/lib/service-icons";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { cn } from "@/lib/utils";
import { type Phrase, stepPhrase, type TriggerKind } from "@/lib/workflow-flow";
import { type WorkflowPreviewSource, workflowPreviewRequest } from "@/lib/workflow-preview";
import {
  type BuildVersion,
  buildVersion,
  definitionKind,
  type ExecutionStep,
  formatDuration,
  joinStepsWithLastRun,
  maskIdentifiers,
  previewSummary,
  type SavedDraft,
  stepKindKey,
  stepResultPreview,
  stepWrites,
  type WorkflowStepDefinition,
  type WorkflowStepView,
} from "@/lib/workflow-steps";
import { stepWasHeld } from "@/pages/runs-model";

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
  const lastRun = lastExecution.data?.items[0] ?? null;
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
    lastRun,
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
        size="sm"
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
        {summary || failure ? (
          <TechnicalDetails testId={`${testId}-technical`}>
            {summary?.stoppedAt ? (
              <FactList
                items={[
                  {
                    label: t("workflow.preview.stoppedAt"),
                    value: <span className="font-mono text-xs">{summary.stoppedAt}</span>,
                    testId: `${testId}-stopped`,
                  },
                ]}
              />
            ) : null}
            {summary ? (
              summary.output === undefined || summary.output === null ? (
                <p className="text-sm text-muted-foreground">{t("workflow.preview.noOutput")}</p>
              ) : (
                <Copyable>
                  <CodeBlock
                    label={t("workflow.preview.output")}
                    code={JSON.stringify(summary.output, null, 2)}
                    lang="json"
                    testId={`${testId}-output`}
                  />
                </Copyable>
              )
            ) : null}
            {failure ? (
              <Copyable>
                <CodeBlock
                  label={t("workflow.preview.error")}
                  code={failure}
                  lang="text"
                  testId={`${testId}-error`}
                />
              </Copyable>
            ) : null}
          </TechnicalDetails>
        ) : null}
      </Section>
    </div>
  );
}

const KIND_ICONS: Record<string, LucideIcon> = {
  request: Plug,
  transform: Shuffle,
  branch: GitBranch,
  loop: Repeat,
  parallel: Split,
  call: Workflow,
  wait: Clock,
  wait_for_event: Bell,
};

function stepIcon(definition: WorkflowStepDefinition): LucideIcon {
  if (definition.essence.kind === "request" && definition.essence.via === "mcp") return Bot;
  if (definition.essence.kind === "transform" && definition.essence.language === "javascript")
    return Code;
  return KIND_ICONS[definition.kind] ?? Workflow;
}

export const TRIGGER_ICONS: Record<TriggerKind, LucideIcon> = {
  schedule: CalendarClock,
  webhook: Webhook,
  request: Hand,
};

export interface StepConnector {
  id: string | null;
  name: string;
  service: ServiceIdentity;
  strip: ConnectorStrip | null;
}

export function stepConnector(
  definition: WorkflowStepDefinition,
  records: readonly ConnectorRecord[],
): StepConnector | null {
  if (!definition.connectorId && !definition.connector) return null;
  const known = records.find((item) =>
    definition.connectorId
      ? item.id === definition.connectorId
      : item.slug === definition.connector,
  );
  if (known)
    return {
      id: known.id,
      name: known.display_name || known.slug,
      service: connectorService(known),
      strip: connectorRecordStrip(known),
    };
  const driver = definition.essence.kind === "request" ? definition.essence.via : null;
  return definition.connectorId
    ? { id: definition.connectorId, name: "", service: { kind: "generic", driver }, strip: null }
    : null;
}

function useStepPhrase(): (
  definition: WorkflowStepDefinition,
  connector: StepConnector | null,
) => string {
  const { t } = useI18n();
  return (definition, connector) => {
    const phrase: Phrase = stepPhrase(
      definition,
      connector?.name || null,
      connector?.service ?? null,
    );
    return t(phrase.key, phrase.values);
  };
}

const CARD =
  "flex w-full min-w-0 flex-col justify-start gap-1.5 self-stretch rounded-lg border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-w-[150px] lg:flex-1";

function FlowArrow() {
  return (
    <li
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center py-0.5 text-muted-foreground/50 lg:w-8 [&_svg]:size-4"
    >
      <ArrowDown className="lg:hidden" />
      <ArrowRight className="hidden lg:block" />
    </li>
  );
}

function FlowPlus({ label, onClick, testId }: { label: string; onClick(): void; testId: string }) {
  return (
    <li className="flex shrink-0 items-center justify-center lg:w-8">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        data-testid={testId}
        className="relative inline-grid size-6 place-items-center rounded-full border border-dashed pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
      >
        <Plus aria-hidden="true" />
      </button>
    </li>
  );
}

export interface FlowTrigger {
  kind: TriggerKind;
  label: string;
  line: string;
}

export function WorkflowFlow({
  steps,
  trigger,
  result,
  workflowName,
  canRun,
  editor,
}: {
  steps: WorkflowSteps;
  trigger: FlowTrigger;
  result: string;
  workflowName: string;
  canRun: boolean;
  editor?: StepDraft;
}) {
  const { t } = useI18n();
  const records = useConnectorRecords();
  const phrase = useStepPhrase();
  const [stepParam, setStepParam] = useSearchParamState("step", "", isStepNumber);
  const open = stepParam ? Number(stepParam) - 1 : null;
  const setOpen = (index: number | null) => setStepParam(index === null ? "" : String(index + 1));
  const [editing, setEditing] = useState<number | null>(null);
  const [inserting, setInserting] = useState<number | null>(null);
  const TriggerIcon = TRIGGER_ICONS[trigger.kind];
  const plus = (index: number) =>
    editor ? (
      <FlowPlus
        label={t("workflowFlow.insert", { number: index + 1 })}
        onClick={() => setInserting(index)}
        testId={`workflow-flow-insert-${index}`}
      />
    ) : (
      <FlowArrow />
    );
  const selected = open === null ? null : (steps.views[open] ?? null);
  return (
    <div data-testid="workflow-steps">
      <ol
        className="flex flex-col items-stretch gap-1 overflow-x-auto pb-1 lg:flex-row"
        data-slot="workflow-flow"
        data-testid="workflow-flow"
      >
        <li className="contents">
          <div
            className={cn(CARD, "bg-blue-500/5 hover:border-border hover:bg-blue-500/5")}
            data-testid="workflow-flow-trigger"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {t("workflowFlow.trigger")}
            </span>
            <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4">
              <TriggerIcon aria-hidden="true" className="text-blue-600 dark:text-blue-400" />
              {trigger.label}
            </span>
            <span className="text-xs text-muted-foreground">{trigger.line}</span>
          </div>
        </li>
        {steps.views.map((view, index) => {
          const definition = view.definition;
          const Icon = stepIcon(definition);
          const connector = stepConnector(definition, records);
          const failed = view.lastRun ? statusTone(view.lastRun.status) === "error" : false;
          const tone = view.lastRun
            ? stepWasHeld(view.lastRun)
              ? "warn"
              : statusTone(view.lastRun.status)
            : null;
          const mark = editor?.marks[definition.id];
          return (
            <Fragment key={`${definition.id}:${index}`}>
              {index === 0 ? <FlowArrow /> : plus(index)}
              <li className="contents">
                <button
                  type="button"
                  onClick={() => setOpen(index)}
                  className={cn(CARD, failed && "border-destructive/50 bg-destructive/5")}
                  data-testid={`workflow-step-${index}`}
                  aria-label={t("workflowFlow.openStep", {
                    number: index + 1,
                    name: phrase(definition, connector),
                  })}
                >
                  <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {t("workflowFlow.stepNumber", { number: index + 1 })} ·{" "}
                      {t(stepKindKey(definitionKind(definition, connector?.service ?? null)))}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {mark ? (
                        <span data-testid={`workflow-step-${index}-mark`}>
                          {t(STEP_MARK_KEYS[mark])}
                        </span>
                      ) : null}
                      <span
                        aria-hidden="true"
                        data-testid={`workflow-step-${index}-dot`}
                        data-tone={tone ?? "none"}
                        title={
                          view.lastRun ? t("workflowFlow.lastRunDot") : t("workflow.neverRanShort")
                        }
                        className={cn(
                          "size-2 rounded-full",
                          tone && tone !== "neutral" ? STATUS_DOT[tone] : "bg-muted-foreground/30",
                        )}
                      />
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4">
                    {connector ? (
                      <ServiceIcon service={connector.service} />
                    ) : (
                      <Icon aria-hidden="true" className="shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {phrase(definition, connector)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {connector?.name ||
                      t(
                        definition.kind === "request"
                          ? "workflowFlow.aService"
                          : "workflowFlow.inSubKit",
                      )}
                  </span>
                </button>
              </li>
            </Fragment>
          );
        })}
        {steps.views.length === 0 ? plus(0) : plus(steps.views.length)}
        <li className="contents">
          <div
            className={cn(CARD, "bg-emerald-500/5 hover:border-border hover:bg-emerald-500/5")}
            data-testid="workflow-flow-result"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {t("workflowFlow.result")}
            </span>
            <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4">
              <Flag aria-hidden="true" className="text-emerald-600 dark:text-emerald-400" />
              {result}
            </span>
          </div>
        </li>
      </ol>
      {selected && open !== null ? (
        <StepSheet
          workflowName={workflowName}
          view={selected}
          index={open}
          total={steps.views.length}
          connector={stepConnector(selected.definition, records)}
          canRun={canRun}
          steps={steps}
          onClose={() => setOpen(null)}
          {...(editor
            ? {
                editor: {
                  edit: () => {
                    setOpen(null);
                    setEditing(open);
                  },
                  up: open > 0 ? () => editor.move(open, -1) : undefined,
                  down: open < steps.views.length - 1 ? () => editor.move(open, 1) : undefined,
                  remove: () => {
                    setOpen(null);
                    editor.remove(open);
                  },
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
      {editor && inserting !== null ? (
        <StepDialog
          open
          onOpenChange={(next) => !next && setInserting(null)}
          step={null}
          taken={editor.steps.map(stepId)}
          onApply={(step) => editor.insert(inserting, step)}
        />
      ) : null}
    </div>
  );
}

function StepSheet({
  view,
  workflowName,
  index,
  total,
  connector,
  canRun,
  steps,
  onClose,
  editor,
}: {
  view: WorkflowStepView;
  workflowName: string;
  index: number;
  total: number;
  connector: StepConnector | null;
  canRun: boolean;
  steps: WorkflowSteps;
  onClose: () => void;
  editor?: { edit(): void; up?: () => void; down?: () => void; remove(): void };
}) {
  const { t, dateTime } = useI18n();
  const phrase = useStepPhrase();
  const testId = `workflow-step-${index}`;
  const { definition, lastRun } = view;
  const lastResult = stepResultPreview(lastRun);
  const called = definition.essence.kind === "call" ? definition.essence : null;
  const result = steps.results[definition.id] ?? null;
  const running = steps.running === definition.id;
  const writes = stepWrites(definition);
  const failed = lastRun ? statusTone(lastRun.status) === "error" : false;
  const when = lastRun?.finished_at ?? lastRun?.started_at ?? null;
  const reason =
    failed && typeof lastRun?.error === "string"
      ? maskIdentifiers(lastRun.error.split("\n")[0] ?? "")
      : null;
  const facts: Fact[] = [
    ...(writes === null
      ? []
      : [
          {
            label: t("workflowFlow.sheet.effect"),
            value: t(writes ? "workflowFlow.sheet.writes" : "workflowFlow.sheet.reads"),
            testId: `${testId}-effect`,
          },
        ]),
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
                {t("workflow.fact.callsOpen")}
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
  const menu: ActionMenuItem[] = [
    ...(canRun
      ? [
          {
            label: t(running ? "workflow.testing" : "workflow.testStep"),
            disabled: steps.running !== null,
            onSelect: () =>
              void steps.runOne(definition.id, { source: "step", step: definition.raw }),
            testId: `${testId}-test`,
          },
        ]
      : []),
    ...(editor?.up
      ? [{ label: t("stepEditor.up"), onSelect: editor.up, testId: `${testId}-up` }]
      : []),
    ...(editor?.down
      ? [{ label: t("stepEditor.down"), onSelect: editor.down, testId: `${testId}-down` }]
      : []),
    ...(editor
      ? [
          {
            label: t("stepEditor.remove"),
            onSelect: editor.remove,
            destructive: true,
            testId: `${testId}-remove`,
          },
        ]
      : []),
  ];
  return (
    <RecordSheet
      dock
      open
      onOpenChange={(next) => !next && onClose()}
      title={phrase(definition, connector)}
      subtitle={t("workflowFlow.sheet.subtitle", {
        number: index + 1,
        total,
        kind: t(stepKindKey(definitionKind(definition, connector?.service ?? null))),
      })}
      badge={
        lastRun ? (
          <StatusBadge
            state={stepWasHeld(lastRun) ? "pending" : lastRun.status}
            label={stepWasHeld(lastRun) ? t("workflow.preview.held") : undefined}
          />
        ) : undefined
      }
      action={
        editor ? (
          <ActionButton size="sm" onClick={editor.edit} testId={`${testId}-sheet-edit`}>
            {t("stepEditor.edit")}
          </ActionButton>
        ) : undefined
      }
      menu={
        menu.length > 0 ? (
          <ActionMenu alwaysMenu items={menu} testId={`${testId}-menu`} />
        ) : undefined
      }
      testId={`${testId}-sheet`}
      closeTestId={`${testId}-close`}
    >
      <p className="text-sm text-muted-foreground">{workflowName}</p>
      {connector?.id ? (
        <a
          href={absolute(connectorHref(connector.id))}
          className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
          data-testid={`${testId}-connector`}
        >
          <ServiceIcon service={connector.service} tile="md" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              {connector.name || t("authority.configuredConnector")}
            </span>
            {connector.strip ? (
              <span
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                data-testid={`${testId}-connector-state`}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[connector.strip.tone])}
                />
                {t(CONNECTOR_STRIP_KEYS[connector.strip.kind])}
              </span>
            ) : null}
          </span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </a>
      ) : null}
      <Section label={t("workflowFlow.sheet.lastRun")} testId={`${testId}-last-run`}>
        {lastRun ? (
          <div
            className={cn(
              "rounded-lg border p-3 text-sm",
              failed && "border-destructive/50 text-destructive",
            )}
            data-testid={`${testId}-last-run-banner`}
          >
            <p className="font-medium">
              {t(failed ? "workflowFlow.sheet.failed" : "workflowFlow.sheet.succeeded", {
                when: when ? dateTime(when) : "—",
              })}
              {lastRun.duration_ms !== null && lastRun.duration_ms !== undefined
                ? ` · ${formatDuration(lastRun.duration_ms)}`
                : ""}
            </p>
            {reason ? <p className="mt-1 text-foreground">{reason}</p> : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("workflow.neverRan")}</p>
        )}
      </Section>
      {facts.length > 0 ? <FactList items={facts} testId={`${testId}-facts`} /> : null}
      {result ? <PreviewCard result={result} total={1} testId={`${testId}-test-result`} /> : null}
      <TechnicalDetails testId={`${testId}-technical`}>
        <FactList
          items={[
            {
              label: t("workflowFlow.sheet.key"),
              value: <span className="break-all font-mono text-xs">{definition.id}</span>,
              testId: `${testId}-key`,
            },
          ]}
        />
        <div className="flex flex-col gap-3" data-testid={`${testId}-configuration`}>
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
        </div>
        {lastResult ? (
          <Copyable>
            <CodeBlock
              label={t("workflow.lastResult")}
              code={lastResult}
              lang="json"
              testId={`${testId}-last-result`}
            />
          </Copyable>
        ) : null}
      </TechnicalDetails>
    </RecordSheet>
  );
}

function isStepNumber(value: string): value is string {
  return /^[1-9]\d{0,3}$/.test(value);
}
