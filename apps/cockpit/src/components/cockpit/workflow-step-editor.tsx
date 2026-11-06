import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, GitBranch, type LucideIcon, Plug, Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useDirtyGuard } from "@/app/version-notice";
import { connectorService, useConnectorRecords } from "@/components/cockpit/connector-names";
import {
  CheckListField,
  ChoiceField,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/cockpit/form-field";
import {
  ActionButton,
  ChoiceCards,
  ContextHelp,
  FormDialog,
  Input,
  TechnicalDetails,
} from "@/components/cockpit/patterns";
import { ServiceIcon } from "@/components/cockpit/service-icon";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  formFromStep,
  isFormStep,
  parseDuration,
  STEP_FORM_ERROR_FIELDS,
  STEP_FORM_KINDS,
  STEP_METHODS,
  type StepForm,
  type StepFormError,
  type StepFormField,
  type StepFormKind,
  type StepMethod,
  stepFromForm,
  stepKeyFromName,
} from "@/lib/step-form";
import { type Phrase, stepPhrase } from "@/lib/workflow-flow";
import { workflowStepChanges } from "@/lib/workflow-step-changes";
import { readStepDefinition } from "@/lib/workflow-steps";

type DraftUpdate = components["schemas"]["UpdateWorkflowDraft"];
type RecordValue = Record<string, unknown>;

export function definitionFromRecord(record: RecordValue, steps: readonly unknown[]): RecordValue {
  if (
    !record.definition ||
    typeof record.definition !== "object" ||
    Array.isArray(record.definition)
  ) {
    throw new Error("workflow definition is unavailable");
  }
  const definition: RecordValue = { ...(record.definition as RecordValue), steps: [...steps] };
  for (const field of ["name", "slug", "description"] as const) {
    const value = record[field];
    if (value !== null && value !== undefined) definition[field] = value;
    if (field === "description" && value === null) delete definition.description;
  }
  return definition;
}

export function definitionForStepSave(
  record: RecordValue,
  steps: readonly unknown[],
  waitingDefinition?: RecordValue,
): RecordValue {
  return waitingDefinition ? { ...waitingDefinition } : definitionFromRecord(record, steps);
}

export function stepId(step: unknown): string {
  return step && typeof step === "object" && typeof (step as RecordValue).id === "string"
    ? ((step as RecordValue).id as string)
    : "";
}

function moveStep<T>(steps: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  if (to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

export function insertStep<T>(steps: readonly T[], index: number, step: T): T[] {
  const at = Math.max(0, Math.min(index, steps.length));
  return [...steps.slice(0, at), step, ...steps.slice(at)];
}

export function useStepDraft(saved: readonly unknown[]) {
  const [draft, setDraft] = useState<unknown[] | null>(null);
  const [changes, setChanges] = useState(0);
  const [marks, setMarks] = useState<Record<string, StepMark>>({});
  const key = JSON.stringify(saved);
  useEffect(() => {
    setDraft(null);
    setChanges(0);
    setMarks({});
  }, [key]);
  const steps = draft ?? [...saved];
  const dirty = draft !== null && JSON.stringify(draft) !== key;
  useDirtyGuard(dirty);
  const change = (
    next: unknown[],
    mark?: (current: Record<string, StepMark>) => Record<string, StepMark>,
  ) => {
    setDraft(next);
    setChanges((count) => count + 1);
    if (mark) setMarks(mark);
  };
  return {
    steps,
    dirty,
    changes,
    marks,
    replace: (index: number, step: unknown) =>
      change(
        steps.map((current, at) => (at === index ? step : current)),
        (current) => {
          const before = stepId(steps[index]);
          const { [before]: was, ...rest } = current;
          return { ...rest, [stepId(step)]: was === "new" ? "new" : "changed" };
        },
      ),
    move: (index: number, by: -1 | 1) =>
      change(moveStep(steps, index, by), (current) => {
        const id = stepId(steps[index]);
        return current[id] ? current : { ...current, [id]: "moved" };
      }),
    remove: (index: number) =>
      change(
        steps.filter((_, at) => at !== index),
        (current) => {
          const { [stepId(steps[index])]: _gone, ...rest } = current;
          return rest;
        },
      ),
    insert: (index: number, step: unknown) =>
      change(insertStep(steps, index, step), (current) => ({
        ...current,
        [stepId(step)]: "new",
      })),
    discard: () => {
      setDraft(null);
      setChanges(0);
      setMarks({});
    },
  };
}

type StepMark = "new" | "changed" | "moved";

export type StepDraft = ReturnType<typeof useStepDraft>;

const KIND_ICONS: Record<StepFormKind, LucideIcon> = {
  request: Plug,
  transform: Shuffle,
  branch: GitBranch,
  wait: Clock,
};

const KIND_LINES: Record<StepFormKind, TranslationKey> = {
  request: "stepWizard.kind.request",
  transform: "stepWizard.kind.transform",
  branch: "stepWizard.kind.branch",
  wait: "stepWizard.kind.wait",
};

const METHOD_WORDS: Record<StepMethod, TranslationKey> = {
  GET: "stepWizard.method.get",
  POST: "stepWizard.method.post",
  PUT: "stepWizard.method.put",
  PATCH: "stepWizard.method.patch",
  DELETE: "stepWizard.method.delete",
};

type Phase = "kind" | "service" | "fields";

export function StepDialog({
  open,
  onOpenChange,
  step,
  taken,
  onApply,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  step: unknown;
  taken: readonly string[];
  onApply(step: unknown): void;
}) {
  const { t } = useI18n();
  const connectors = useConnectorRecords(open);
  const editing = step !== null && step !== undefined;
  const structured = isFormStep(step);
  const [form, setForm] = useState<StepForm>(() => formFromStep(step, ""));
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>(editing ? "fields" : "kind");
  const [search, setSearch] = useState("");
  const [text, setText] = useState(() => JSON.stringify(step, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: StepFormField; text: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setForm(formFromStep(step, ""));
    setLabel("");
    setPhase(step === null || step === undefined ? "kind" : "fields");
    setSearch("");
    setText(JSON.stringify(step, null, 2));
    setError(null);
    setFieldError(null);
  }, [open, step]);
  const set = (patch: Partial<StepForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFieldError(null);
  };
  const errorOf = (field: StepFormField) => (fieldError?.field === field ? fieldError.text : null);
  const others = taken.map((id) => ({ value: id, label: id }));
  const connector = connectors.find((item) => item.id === form.connectorId) ?? null;
  const apply = () => {
    if (!structured) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !stepId(parsed))
          return setError(t("stepEditor.needsId"));
        onApply(parsed);
        onOpenChange(false);
      } catch {
        setError(t("stepEditor.invalidJson"));
      }
      return;
    }
    const named = editing ? form : { ...form, name: stepKeyFromName(label, form.kind, taken) };
    const result = stepFromForm(named, step, taken);
    if ("error" in result)
      return setFieldError({
        field: STEP_FORM_ERROR_FIELDS[result.error],
        text: t(STEP_FORM_ERRORS[result.error]),
      });
    onApply(result.step);
    onOpenChange(false);
  };
  const title = editing ? t("stepEditor.editTitle") : t("stepEditor.addTitle");
  if (!structured)
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={t("stepWizard.rawOnly")}
        submit={{ label: t("stepEditor.apply") }}
        onSubmit={apply}
        error={error}
        size="wide"
        testId="step-dialog"
      >
        <TechnicalDetails testId="step-raw">
          <TextAreaField
            id="step-config"
            label={t("workflow.configuration")}
            help={t("stepEditor.configHelp")}
            value={text}
            onChange={setText}
            rows={14}
            mono
          />
        </TechnicalDetails>
      </FormDialog>
    );
  if (phase === "kind")
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={t("stepWizard.kindQuestion")}
        size="wide"
        step="kind"
        testId="step-dialog"
      >
        <ChoiceCards
          items={STEP_FORM_KINDS.map((kind) => {
            const Icon = KIND_ICONS[kind];
            return {
              icon: <Icon />,
              title: t(`workflow.kind.${kind}`),
              line: t(KIND_LINES[kind]),
              selected: form.kind === kind,
              onSelect: () => {
                set({ kind });
                setPhase(kind === "request" ? "service" : "fields");
              },
              testId: `step-kind-${kind}`,
            };
          })}
        />
      </FormDialog>
    );
  if (phase === "service") {
    const term = search.trim().toLowerCase();
    const matches = connectors.filter(
      (item) =>
        !term ||
        item.display_name.toLowerCase().includes(term) ||
        item.slug.toLowerCase().includes(term),
    );
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={t("stepWizard.serviceQuestion")}
        size="wide"
        step="service"
        back={{ label: t("create.back"), onClick: () => setPhase("kind") }}
        testId="step-dialog"
      >
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("stepWizard.serviceSearch")}
          aria-label={t("stepWizard.serviceSearch")}
          data-testid="step-service-search"
        />
        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="step-service-none">
            {t("stepWizard.noService")}
          </p>
        ) : (
          <ChoiceCards
            compact
            items={matches.map((item) => ({
              icon: <ServiceIcon service={connectorService(item)} />,
              title: item.display_name || item.slug,
              line: t(item.driver === "mcp" ? "stepWizard.service.mcp" : "stepWizard.service.web"),
              selected: form.connectorId === item.id,
              onSelect: () => {
                set({ connectorId: item.id });
                setPhase("fields");
              },
              testId: `step-service-${item.slug}`,
            }))}
          />
        )}
      </FormDialog>
    );
  }
  const phrase = previewPhrase(form, connector?.display_name ?? null);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={t(phrase.key, phrase.values)}
      submit={{ label: t(editing ? "stepEditor.apply" : "stepEditor.add"), testId: "step-submit" }}
      onSubmit={apply}
      error={error}
      size="wide"
      step="fields"
      {...(editing
        ? {}
        : {
            back: {
              label: t("create.back"),
              onClick: () => setPhase(form.kind === "request" ? "service" : "kind"),
            },
          })}
      testId="step-dialog"
    >
      {editing ? null : (
        <TextField
          id="step-name"
          label={t("stepWizard.name")}
          placeholder={t("stepWizard.namePlaceholder")}
          help={t("stepWizard.nameHelp")}
          value={label}
          onChange={setLabel}
          error={errorOf("name")}
        />
      )}
      {form.kind === "request" ? (
        <>
          {editing ? (
            <SelectField
              id="step-connector"
              label={t("authority.connector")}
              value={form.connectorId}
              onChange={(connectorId) => set({ connectorId })}
              error={errorOf("connectorId")}
              options={connectors.map((item) => ({
                value: item.id,
                label: item.display_name || item.slug,
              }))}
            />
          ) : null}
          <ChoiceField<StepMethod>
            label={t("stepWizard.methodQuestion")}
            value={form.method}
            onChange={(method) => set({ method })}
            testId="step-method"
            options={STEP_METHODS.map((method) => ({
              value: method,
              label: t(METHOD_WORDS[method]),
            }))}
          />
          <TextField
            id="step-path"
            label={t("stepWizard.path")}
            help={t("stepWizard.pathHelp")}
            placeholder="/messages/send"
            value={form.path}
            onChange={(path) => set({ path })}
            error={errorOf("path")}
            mono
          />
          {form.method === "GET" ? null : (
            <p className="text-xs text-muted-foreground" data-testid="step-sends-hint">
              {t("stepWizard.sendsHint")}
            </p>
          )}
          <TechnicalDetails testId="step-request-technical">
            <TextAreaField
              id="step-query"
              label={t("stepEditor.query")}
              help={t("stepEditor.queryHelp")}
              placeholder={'{ "limit": 10 }'}
              value={form.query}
              onChange={(query) => set({ query })}
              error={errorOf("query")}
              rows={3}
              mono
            />
            <TextAreaField
              id="step-headers"
              label={t("stepEditor.headers")}
              help={t("stepEditor.headersHelp")}
              placeholder="Accept: application/json"
              value={form.headers}
              onChange={(headers) => set({ headers })}
              error={errorOf("headers")}
              rows={3}
              mono
            />
            <TextAreaField
              id="step-body"
              label={t("stepEditor.body")}
              help={t("stepEditor.bodyHelp")}
              value={form.body}
              onChange={(body) => set({ body })}
              error={errorOf("body")}
              rows={6}
              mono
            />
          </TechnicalDetails>
        </>
      ) : form.kind === "wait" ? (
        <TextField
          id="step-wait"
          label={t("stepWizard.waitQuestion")}
          placeholder={t("stepEditor.durationPlaceholder")}
          value={form.wait}
          onChange={(wait) => set({ wait })}
          error={errorOf("wait")}
        />
      ) : form.kind === "branch" ? (
        <>
          <TextField
            id="step-when"
            label={t("stepEditor.when")}
            help={t("stepEditor.whenHelp")}
            placeholder="fetch.data.count > 0"
            value={form.when}
            onChange={(when) => set({ when })}
            error={errorOf("when")}
            mono
          />
          <CheckListField
            id="step-then"
            label={t("stepEditor.then")}
            help={t("stepEditor.thenHelp")}
            values={form.thenSteps}
            onChange={(thenSteps) => set({ thenSteps })}
            options={others}
            empty={t("stepEditor.branchNoSteps")}
            error={errorOf("thenSteps")}
          />
          <CheckListField
            id="step-else"
            label={t("stepEditor.else")}
            help={t("stepEditor.elseHelp")}
            values={form.elseSteps}
            onChange={(elseSteps) => set({ elseSteps })}
            options={others}
            empty={t("stepEditor.branchNoSteps")}
            error={errorOf("elseSteps")}
          />
        </>
      ) : (
        <TechnicalDetails testId="step-code-technical">
          <TextAreaField
            id="step-code"
            label={t("workflow.kind.transform")}
            help={t("stepEditor.codeHelp")}
            value={form.code}
            onChange={(code) => set({ code })}
            error={errorOf("code")}
            rows={5}
            mono
          />
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {t("stepEditor.sandboxTools")}
            <ContextHelp label={t("stepEditor.sandboxTools")} testId="step-code-sandbox-tools-help">
              {t("stepEditor.sandboxToolsHelp")}
            </ContextHelp>
          </span>
        </TechnicalDetails>
      )}
      {fieldError &&
      (fieldError.field === "code" ||
        fieldError.field === "query" ||
        fieldError.field === "headers" ||
        fieldError.field === "body") ? (
        <p className="text-sm text-destructive" data-testid="step-technical-error">
          {fieldError.text}
        </p>
      ) : null}
    </FormDialog>
  );
}

function previewPhrase(form: StepForm, service: string | null): Phrase {
  return stepPhrase(
    readStepDefinition(
      {
        id: "preview",
        kind: form.kind,
        method: form.method,
        duration_ms: form.kind === "wait" ? (parseDuration(form.wait) ?? undefined) : undefined,
      },
      0,
    ),
    service,
  );
}

const STEP_FORM_ERRORS = {
  nameMissing: "create.nameMissing",
  nameInvalid: "stepEditor.idInvalid",
  nameTaken: "stepEditor.idTaken",
  connectorMissing: "stepEditor.connectorMissing",
  pathInvalid: "stepEditor.pathInvalid",
  queryInvalid: "stepEditor.queryInvalid",
  headersInvalid: "stepEditor.headersInvalid",
  bodyInvalid: "stepEditor.bodyInvalid",
  codeMissing: "stepEditor.codeMissing",
  waitInvalid: "stepEditor.waitInvalid",
  whenMissing: "stepEditor.whenMissing",
  thenMissing: "stepEditor.thenMissing",
  branchUnknownStep: "stepEditor.branchUnknownStep",
  branchOverlap: "stepEditor.branchOverlap",
} as const satisfies Record<StepFormError, TranslationKey>;

export function stepSaveConflict(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const reason = error.details?.reason;
  return reason === "draft_conflict" || reason === "version_conflict";
}

export function stepSaveRequest(
  record: RecordValue,
  steps: readonly unknown[],
  waitingDefinition?: RecordValue,
): { base: RecordValue; body: RecordValue } {
  const base = definitionForStepSave(
    record,
    Array.isArray(record.steps) ? record.steps : [],
    waitingDefinition,
  );
  return {
    base,
    body: {
      definition: { ...base, steps: [...steps] },
      expected_draft_version_id:
        typeof record.draft_version_id === "string" ? record.draft_version_id : null,
      ...(Object.hasOwn(record, "current_version_id")
        ? {
            expected_current_version_id:
              typeof record.current_version_id === "string" ? record.current_version_id : null,
          }
        : {}),
    },
  };
}

export function StepSaveBarView({
  changes,
  conflict,
  pending,
  onSave,
  onDiscard,
  onReload,
}: {
  changes: number;
  conflict: boolean;
  pending: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-sm shadow-sm"
      data-slot="savebar"
      data-state={conflict ? "conflict" : "dirty"}
      data-testid="step-savebar"
    >
      <span role={conflict ? "alert" : undefined}>
        {conflict
          ? t("stepEditor.conflict")
          : t(changes === 1 ? "stepEditor.unsaved.one" : "stepEditor.unsaved.other", {
              count: changes,
            })}
      </span>
      <span className="flex items-center gap-2">
        {conflict ? (
          <ActionButton variant="primary" onClick={onReload} testId="step-savebar-reload">
            {t("stepEditor.reload")}
          </ActionButton>
        ) : (
          <>
            <ActionButton
              variant="ghost"
              onClick={onDiscard}
              disabled={pending}
              testId="step-savebar-discard"
            >
              {t("common.discard")}
            </ActionButton>
            <ActionButton
              variant="primary"
              pending={pending}
              onClick={onSave}
              testId="step-savebar-save"
            >
              {t("common.save")}
            </ActionButton>
          </>
        )}
      </span>
    </div>
  );
}

export function StepSaveBar({
  workflowId,
  record,
  draft,
}: {
  workflowId: string;
  record: RecordValue;
  draft: StepDraft;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (!draft.dirty) setConflict(false);
  }, [draft.dirty]);
  const save = useMutation({
    mutationFn: async () => {
      const expected = typeof record.draft_version_id === "string" ? record.draft_version_id : null;
      let waitingDefinition: RecordValue | undefined;
      if (expected && expected !== record.current_version_id) {
        const waiting = await apiCall("get", "/v1/workflows/{id}/draft", {
          path: { id: workflowId },
        });
        waitingDefinition = waiting.definition;
      }
      const { base, body } = stepSaveRequest(record, draft.steps, waitingDefinition);
      const saved = await apiCall("put", "/v1/workflows/{id}/draft", {
        path: { id: workflowId },
        body: body as DraftUpdate,
      });

      return {
        saved,
        changes: workflowStepChanges(
          Array.isArray(base.steps) ? base.steps : [],
          saved.definition.steps,
        ),
      };
    },
    onSuccess: async ({ saved, changes }) => {
      const summary = [
        changes.added
          ? t(changes.added === 1 ? "stepEditor.savedAdded.one" : "stepEditor.savedAdded.other", {
              count: changes.added,
            })
          : null,
        changes.removed
          ? t(
              changes.removed === 1
                ? "stepEditor.savedRemoved.one"
                : "stepEditor.savedRemoved.other",
              { count: changes.removed },
            )
          : null,
        changes.changed
          ? t(
              changes.changed === 1
                ? "stepEditor.savedChanged.one"
                : "stepEditor.savedChanged.other",
              { count: changes.changed },
            )
          : null,
        changes.reordered ? t("stepEditor.savedReordered") : null,
      ]
        .filter(Boolean)
        .join(" · ");
      toast.success(
        [t("stepEditor.savedVersion", { version: `v${saved.version}` }), summary]
          .filter(Boolean)
          .join(" · "),
      );
      draft.discard();
      await client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] });
      await invalidateWorkflowAutomation(client, workflowId);
    },
    onError: (error) => {
      if (stepSaveConflict(error)) {
        setConflict(true);
        return;
      }
      toast.error(
        error instanceof ApiError && error.message
          ? t("stepEditor.refused", { reason: error.message })
          : t("common.actionFailed"),
      );
    },
  });
  const reload = async () => {
    draft.discard();
    setConflict(false);
    await client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] });
    await invalidateWorkflowAutomation(client, workflowId);
  };
  if (!draft.dirty) return null;
  return (
    <StepSaveBarView
      changes={draft.changes}
      conflict={conflict}
      pending={save.isPending}
      onSave={() => save.mutate()}
      onDiscard={draft.discard}
      onReload={() => void reload()}
    />
  );
}
