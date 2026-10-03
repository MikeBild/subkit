import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useDirtyGuard } from "@/app/version-notice";
import { FormError, SelectField, TextAreaField, TextField } from "@/components/cockpit/form-field";
import { ActionButton, FormDialog } from "@/components/cockpit/patterns";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { useI18n } from "@/lib/i18n-context";

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

export type StepKindChoice = "request" | "transform" | "wait";

/** The skeleton a new step of each kind starts as — valid once its blanks are filled. */
export function newStep(kind: StepKindChoice, id: string): RecordValue {
  switch (kind) {
    case "request":
      return { id, kind: "request", connector_id: "", method: "GET", path: "/" };
    case "transform":
      return { id, kind: "transform", function: "export default (input) => input;" };
    case "wait":
      return { id, kind: "wait", duration: "PT1M" };
  }
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
  const key = JSON.stringify(saved);
  // A new saved version replaces whatever was edited on top of the old one.
  useEffect(() => {
    setDraft(null);
    setChanges(0);
  }, [key]);
  const steps = draft ?? [...saved];
  const dirty = draft !== null;
  useDirtyGuard(dirty);
  const change = (next: unknown[]) => {
    setDraft(next);
    setChanges((count) => count + 1);
  };
  return {
    steps,
    dirty,
    changes,
    replace: (index: number, step: unknown) =>
      change(steps.map((current, at) => (at === index ? step : current))),
    move: (index: number, by: -1 | 1) => change(moveStep(steps, index, by)),
    remove: (index: number) => change(steps.filter((_, at) => at !== index)),
    add: (step: unknown) => change([...steps, step]),
    discard: () => {
      setDraft(null);
      setChanges(0);
    },
  };
}

export type StepDraft = ReturnType<typeof useStepDraft>;

/** One step's configuration, edited as the engine stores it. */
export function StepEditDialog({
  open,
  onOpenChange,
  step,
  onApply,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  step: unknown;
  onApply(step: unknown): void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(() => JSON.stringify(step, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText(JSON.stringify(step, null, 2));
      setError(null);
    }
  }, [open, step]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={t("stepEditor.editTitle", { step: stepId(step) })}
      submit={{ label: t("stepEditor.apply") }}
      onSubmit={() => {
        try {
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !stepId(parsed)) {
            setError(t("stepEditor.needsId"));
            return;
          }
          onApply(parsed);
          onOpenChange(false);
        } catch {
          setError(t("stepEditor.invalidJson"));
        }
      }}
      testId="step-edit-dialog"
    >
      <TextAreaField
        id="step-edit-config"
        label={t("workflow.configuration")}
        help={t("stepEditor.configHelp")}
        value={text}
        onChange={setText}
        rows={14}
        mono
      />
      <FormError message={error} testId="step-edit-error" />
    </FormDialog>
  );
}

/** "Schritt hinzufügen": the kind and the id; the rest is filled in the step's sheet. */
export function StepAddDialog({
  open,
  onOpenChange,
  taken,
  onAdd,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  taken: readonly string[];
  onAdd(step: unknown): void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<StepKindChoice>("request");
  const [id, setId] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setId("");
          setError(null);
        }
      }}
      title={t("stepEditor.addTitle")}
      submit={{ label: t("stepEditor.add") }}
      onSubmit={() => {
        const trimmed = id.trim();
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) return setError(t("stepEditor.idInvalid"));
        if (taken.includes(trimmed)) return setError(t("stepEditor.idTaken"));
        onAdd(newStep(kind, trimmed));
        setId("");
        setError(null);
        onOpenChange(false);
      }}
      testId="step-add-dialog"
    >
      <SelectField
        id="step-add-kind"
        label={t("workflowSteps.column.kind")}
        value={kind}
        onChange={(value) => setKind(value as StepKindChoice)}
        options={[
          { value: "request", label: t("workflow.kind.request") },
          { value: "transform", label: t("workflow.kind.transform") },
          { value: "wait", label: t("workflow.kind.wait") },
        ]}
      />
      <TextField
        id="step-add-id"
        label={t("stepEditor.id")}
        help={t("stepEditor.idHelp")}
        value={id}
        onChange={setId}
        mono
      />
      <FormError message={error} testId="step-add-error" />
    </FormDialog>
  );
}

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
