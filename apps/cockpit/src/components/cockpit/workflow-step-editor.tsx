import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useDirtyGuard } from "@/app/version-notice";
import { useConnectorRecords } from "@/components/cockpit/connector-names";
import {
  CheckListField,
  ChoiceField,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/cockpit/form-field";
import { ActionButton, FormDialog } from "@/components/cockpit/patterns";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  formFromStep,
  isFormStep,
  STEP_FORM_ERROR_FIELDS,
  STEP_FORM_KINDS,
  STEP_METHODS,
  type StepForm,
  type StepFormError,
  type StepFormField,
  type StepFormKind,
  type StepMethod,
  stepFromForm,
} from "@/lib/step-form";
import { workflowStepChanges } from "@/lib/workflow-step-changes";

type WorkflowDraft = components["schemas"]["WorkflowDraft"];
type RecordValue = Record<string, unknown>;

const DEFINITION_FIELDS = [
  "name",
  "slug",
  "description",
  "input_schema",
  "output_schema",
  "output_transform",
  "output_transform_function",
  "response_filters",
  "validation_expression",
  "validation_function",
  "timeout_ms",
  "max_llm_tokens_per_run",
  "trigger",
] as const;

export function definitionFromRecord(record: RecordValue, steps: readonly unknown[]): RecordValue {
  const definition: RecordValue = { steps: [...steps] };
  for (const field of DEFINITION_FIELDS) {
    const value = record[field];
    if (value !== null && value !== undefined) definition[field] = value;
  }
  return definition;
}

export function stepId(step: unknown): string {
  return step && typeof step === "object" && typeof (step as RecordValue).id === "string"
    ? ((step as RecordValue).id as string)
    : "";
}

export function moveStep<T>(steps: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  if (to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
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
    add: (step: unknown) =>
      change([...steps, step], (current) => ({ ...current, [stepId(step)]: "new" })),
    discard: () => {
      setDraft(null);
      setChanges(0);
      setMarks({});
    },
  };
}

export type StepMark = "new" | "changed" | "moved";

export type StepDraft = ReturnType<typeof useStepDraft>;

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
  const firstConnector = connectors[0]?.id ?? "";
  const [form, setForm] = useState<StepForm>(() => formFromStep(step, firstConnector));
  const [text, setText] = useState(() => JSON.stringify(step, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: StepFormField; text: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setForm(formFromStep(step, ""));
    setText(JSON.stringify(step, null, 2));
    setError(null);
    setFieldError(null);
  }, [open, step]);
  useEffect(() => {
    if (firstConnector && !form.connectorId)
      setForm((current) => ({ ...current, connectorId: firstConnector }));
  }, [firstConnector, form.connectorId]);
  const set = (patch: Partial<StepForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFieldError(null);
  };
  const errorOf = (field: StepFormField) => (fieldError?.field === field ? fieldError.text : null);
  const others = taken.map((id) => ({ value: id, label: id }));
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
    const result = stepFromForm(form, step, taken);
    if ("error" in result)
      return setFieldError({
        field: STEP_FORM_ERROR_FIELDS[result.error],
        text: t(STEP_FORM_ERRORS[result.error]),
      });
    onApply(result.step);
    onOpenChange(false);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("stepEditor.editTitle", { step: stepId(step) }) : t("stepEditor.addTitle")}
      submit={{ label: t(editing ? "stepEditor.apply" : "stepEditor.add") }}
      onSubmit={apply}
      error={error}
      size="wide"
      testId="step-dialog"
    >
      {structured ? (
        <>
          <TextField
            id="step-name"
            label={t("create.name")}
            placeholder={t("stepEditor.namePlaceholder")}
            help={t("stepEditor.idHelp")}
            value={form.name}
            onChange={(name) => set({ name })}
            error={errorOf("name")}
            mono
          />
          <ChoiceField<StepFormKind>
            label={t("workflowSteps.column.kind")}
            value={form.kind}
            onChange={(kind) => set({ kind })}
            testId="step-kind"
            options={STEP_FORM_KINDS.map((kind) => ({
              value: kind,
              label: t(`workflow.kind.${kind}`),
            }))}
          />
          {form.kind === "request" ? (
            <>
              <SelectField
                id="step-connector"
                label={t("authority.connector")}
                value={form.connectorId}
                onChange={(connectorId) => set({ connectorId })}
                error={errorOf("connectorId")}
                options={connectors.map((connector) => ({
                  value: connector.id,
                  label: connector.display_name || connector.slug,
                }))}
              />
              <ChoiceField<StepMethod>
                label={t("stepEditor.method")}
                value={form.method}
                onChange={(method) => set({ method })}
                testId="step-method"
                options={STEP_METHODS.map((method) => ({ value: method, label: method }))}
              />
              <TextField
                id="step-path"
                label={t("stepEditor.path")}
                placeholder="/messages/send"
                value={form.path}
                onChange={(path) => set({ path })}
                error={errorOf("path")}
                mono
              />
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
            </>
          ) : form.kind === "wait" ? (
            <TextField
              id="step-wait"
              label={t("stepEditor.duration")}
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
          )}
        </>
      ) : (
        <TextAreaField
          id="step-config"
          label={t("workflow.configuration")}
          help={t("stepEditor.configHelp")}
          value={text}
          onChange={setText}
          rows={14}
          mono
        />
      )}
    </FormDialog>
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

export function StepSaveBar({
  workflowId,
  record,
  draft,
  preview,
}: {
  workflowId: string;
  record: RecordValue;
  draft: StepDraft;
  preview?: ReactNode;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async () => {
      const expected = typeof record.draft_version_id === "string" ? record.draft_version_id : null;
      let base: RecordValue = definitionFromRecord(
        record,
        Array.isArray(record.steps) ? record.steps : [],
      );
      if (expected && expected !== record.current_version_id) {
        const waiting = await apiRequest<WorkflowDraft>(
          `/v1/workflows/${encodeURIComponent(workflowId)}/draft`,
        );
        base = { ...(waiting.definition as unknown as RecordValue) };
      }
      const saved = await apiRequest<WorkflowDraft>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/draft`,
        {
          method: "PUT",
          body: JSON.stringify({
            definition: { ...base, steps: draft.steps },
            expected_draft_version_id: expected,
          }),
        },
      );
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
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.code === "draft_conflict"
          ? t("stepEditor.conflict")
          : error instanceof ApiError && error.message
            ? t("stepEditor.refused", { reason: error.message })
            : t("common.actionFailed"),
      ),
  });
  if (!draft.dirty) return null;
  return (
    <div
      className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-sm shadow-sm"
      data-slot="savebar"
      data-testid="step-savebar"
    >
      <span>
        {t(draft.changes === 1 ? "stepEditor.unsaved.one" : "stepEditor.unsaved.other", {
          count: draft.changes,
        })}
      </span>
      <span className="flex items-center gap-2">
        {preview}
        <ActionButton
          variant="ghost"
          onClick={draft.discard}
          disabled={save.isPending}
          testId="step-savebar-discard"
        >
          {t("common.discard")}
        </ActionButton>
        <ActionButton
          variant="primary"
          pending={save.isPending}
          onClick={() => save.mutate()}
          testId="step-savebar-save"
        >
          {t("common.save")}
        </ActionButton>
      </span>
    </div>
  );
}
