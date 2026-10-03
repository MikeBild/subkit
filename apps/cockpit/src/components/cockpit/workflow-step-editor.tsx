import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useDirtyGuard } from "@/app/version-notice";
import { useConnectorRecords } from "@/components/cockpit/connector-names";
import {
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
  isFormKind,
  STEP_FORM_KINDS,
  STEP_METHODS,
  type StepForm,
  type StepFormError,
  type StepFormKind,
  type StepMethod,
  stepFromForm,
} from "@/lib/step-form";

type WorkflowDraft = components["schemas"]["WorkflowDraft"];
type RecordValue = Record<string, unknown>;

/** The fields of the stored record that belong to the definition, as the engine returns them. */
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

/**
 * The definition a new version starts from: the waiting draft where there is
 * one, else the running version as the record carries it. Empty fields are
 * left out — a definition does not carry `null`s it never had.
 */
export function definitionFromRecord(record: RecordValue, steps: readonly unknown[]): RecordValue {
  const definition: RecordValue = { steps: [...steps] };
  for (const field of DEFINITION_FIELDS) {
    const value = record[field];
    if (value !== null && value !== undefined) definition[field] = value;
  }
  return definition;
}

/** A step's id, as the editor shows and keeps it. */
export function stepId(step: unknown): string {
  return step && typeof step === "object" && typeof (step as RecordValue).id === "string"
    ? ((step as RecordValue).id as string)
    : "";
}

/** Moves the step at `from` one place up (-1) or down (+1); the list is not changed in place. */
export function moveStep<T>(steps: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  if (to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/**
 * The step editor's state (R16): the saved steps, or the reader's changes to
 * them until they are saved as one new version or discarded. A pending change
 * keeps the page from being left without a word (`useDirtyGuard`).
 */
export function useStepDraft(saved: readonly unknown[]) {
  const [draft, setDraft] = useState<unknown[] | null>(null);
  const [changes, setChanges] = useState(0);
  const [marks, setMarks] = useState<Record<string, StepMark>>({});
  const key = JSON.stringify(saved);
  // A new saved version replaces whatever was edited on top of the old one.
  useEffect(() => {
    setDraft(null);
    setChanges(0);
    setMarks({});
  }, [key]);
  const steps = draft ?? [...saved];
  // Undoing every change by hand leaves nothing to save.
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

/** What happened to a step since the saved version: shown beside its name. */
export type StepMark = "new" | "changed" | "moved";

export type StepDraft = ReturnType<typeof useStepDraft>;

/**
 * "Schritt hinzufügen" / "Schritt … bearbeiten" (R16): name and kind, then
 * what the kind needs — a connector, method and path for a call; the code
 * for a transformation; the duration for a pause. A stored step of another
 * kind keeps its configuration and is edited as SubKit stores it.
 */
export function StepDialog({
  open,
  onOpenChange,
  step,
  taken,
  onApply,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The step edited; null adds one. */
  step: unknown;
  /** The other steps' names. */
  taken: readonly string[];
  onApply(step: unknown): void;
}) {
  const { t } = useI18n();
  const connectors = useConnectorRecords(open);
  const editing = step !== null && step !== undefined;
  const raw = editing && typeof step === "object" ? (step as RecordValue) : null;
  const structured = !raw || isFormKind(raw.kind);
  const firstConnector = connectors[0]?.id ?? "";
  const [form, setForm] = useState<StepForm>(() => formFromStep(step, firstConnector));
  const [text, setText] = useState(() => JSON.stringify(step, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setForm(formFromStep(step, ""));
    setText(JSON.stringify(step, null, 2));
    setError(null);
  }, [open, step]);
  // A call that names no connector yet starts with the first one, once the list is there.
  useEffect(() => {
    if (firstConnector && !form.connectorId)
      setForm((current) => ({ ...current, connectorId: firstConnector }));
  }, [firstConnector, form.connectorId]);
  const set = (patch: Partial<StepForm>) => setForm((current) => ({ ...current, ...patch }));
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
    if ("error" in result) return setError(t(STEP_FORM_ERRORS[result.error]));
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
            />
          ) : (
            <TextAreaField
              id="step-code"
              label={t("workflow.kind.transform")}
              help={t("stepEditor.codeHelp")}
              value={form.code}
              onChange={(code) => set({ code })}
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
  codeMissing: "stepEditor.codeMissing",
  waitInvalid: "stepEditor.waitInvalid",
} as const satisfies Record<StepFormError, TranslationKey>;

/**
 * The save bar of the step editor: the count of changes, "Verwerfen" and
 * "Speichern". Saving writes ONE new version as the waiting change; the
 * running version keeps running until that change is approved.
 */
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
  const save = useMutation({
    mutationFn: async () => {
      const expected = typeof record.draft_version_id === "string" ? record.draft_version_id : null;
      // A change that already waits is the base: the new version builds on
      // it, never silently on the running one beneath it.
      let base: RecordValue = definitionFromRecord(record, []);
      if (expected && expected !== record.current_version_id) {
        const waiting = await apiRequest<WorkflowDraft>(
          `/v1/workflows/${encodeURIComponent(workflowId)}/draft`,
        );
        base = { ...(waiting.definition as unknown as RecordValue) };
      }
      return apiRequest<WorkflowDraft>(`/v1/workflows/${encodeURIComponent(workflowId)}/draft`, {
        method: "PUT",
        body: JSON.stringify({
          definition: { ...base, steps: draft.steps },
          expected_draft_version_id: expected,
        }),
      });
    },
    onSuccess: async (saved) => {
      toast.success(t("stepEditor.saved", { version: `v${saved.version}` }));
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
