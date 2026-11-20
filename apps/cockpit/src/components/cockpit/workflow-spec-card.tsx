import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { TextAreaField, TextField } from "@/components/cockpit/form-field";
import {
  ActionButton,
  DataState,
  type Fact,
  FactList,
  FormDialog,
  Section,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  confirmedSpec,
  emptySpec,
  type SpecForm,
  type SpecState,
  specCanConfirm,
  specForm,
  specFormChanged,
  specFormValid,
  specFromForm,
  specSaveBody,
  specState,
  type WorkflowSpec,
  type WorkflowSpecOrigin,
} from "@/lib/workflow-spec";

const STATE_BADGE: Record<SpecState, { state: string; key: TranslationKey }> = {
  missing: { state: "neutral", key: "workflowSpec.state.missing" },
  unconfirmed: { state: "pending", key: "workflowSpec.state.unconfirmed" },
  confirmed: { state: "verified", key: "workflowSpec.state.confirmed" },
};

const ORIGIN_KEYS: Record<WorkflowSpecOrigin, TranslationKey> = {
  person: "workflowSpec.origin.person",
  chat: "workflowSpec.origin.chat",
  derived: "workflowSpec.origin.derived",
};

function useWorkflowSpecDraft(workflowId: string, draftVersionId: string | null) {
  return useQuery({
    queryKey: ["workflow-draft-version", workflowId, draftVersionId, "spec"],
    enabled: draftVersionId !== null,
    queryFn: () => apiCall("get", "/v1/workflows/{id}/draft", { path: { id: workflowId } }),
  });
}

export function WorkflowSpecCard({
  workflowId,
  draftVersionId,
  canWrite,
}: {
  workflowId: string;
  draftVersionId: string | null;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useWorkflowSpecDraft(workflowId, draftVersionId);
  const [editing, setEditing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const draft = query.data;
  const save = useMutation({
    mutationFn: (spec: WorkflowSpec) => {
      if (!draft) throw new Error("no draft");
      return apiCall("put", "/v1/workflows/{id}/draft", {
        path: { id: workflowId },
        body: specSaveBody(draft, spec),
      });
    },
    onSuccess: async (saved) => {
      toast.success(t("workflowSpec.saved", { version: `v${saved.version}` }));
      setEditing(false);
      setConflict(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["workflow-draft-version", workflowId] }),
        client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] }),
        client.invalidateQueries({ queryKey: ["workflow", workflowId, "versions"] }),
      ]);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        (error.details?.reason === "draft_conflict" || error.details?.reason === "version_conflict")
      ) {
        setConflict(true);
        setEditing(false);
        return;
      }
      reportFailure(
        error instanceof ApiError && error.message
          ? t("workflowSpec.refused", { reason: error.message })
          : t("common.actionFailed"),
        error,
      );
    },
  });
  if (draftVersionId === null) return null;
  const spec = draft?.spec ?? null;
  const state = specState(spec);
  const badge = STATE_BADGE[state];
  return (
    <Section
      label={t("workflowSpec.title")}
      aside={
        query.isSuccess ? (
          <StatusBadge state={badge.state} label={t(badge.key)} testId="workflow-spec-state" />
        ) : null
      }
      testId="workflow-spec"
    >
      {query.isPending ? (
        <DataState state="loading" line={t("workflowSpec.title")} />
      ) : query.isError || !draft ? (
        <DataState
          state="error"
          line={t("workflowSpec.loadFailed")}
          onRetry={() => void query.refetch()}
          testId="workflow-spec-error"
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border p-3.5">
          <SpecFacts spec={spec} />
          {conflict ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 text-sm"
              data-testid="workflow-spec-conflict"
            >
              <span className="min-w-0 flex-1">{t("stepEditor.conflict")}</span>
              <ActionButton
                onClick={() => {
                  setConflict(false);
                  void query.refetch();
                }}
                testId="workflow-spec-reload"
              >
                {t("stepEditor.reload")}
              </ActionButton>
            </div>
          ) : canWrite ? (
            <div className="flex flex-wrap gap-2">
              <ActionButton onClick={() => setEditing(true)} testId="workflow-spec-edit">
                {t("workflowSpec.edit")}
              </ActionButton>
              {specCanConfirm(spec) && spec ? (
                <ActionButton
                  variant="primary"
                  pending={save.isPending}
                  onClick={() => save.mutate(confirmedSpec(spec))}
                  testId="workflow-spec-confirm"
                >
                  {t("workflowSpec.confirm")}
                </ActionButton>
              ) : null}
            </div>
          ) : null}
          <SpecDialog
            open={editing}
            onOpenChange={setEditing}
            spec={spec}
            pending={save.isPending}
            onSave={(next) => save.mutate(next)}
          />
        </div>
      )}
    </Section>
  );
}

function fieldValue(fields: WorkflowSpec["inputs"], none: string) {
  if (fields.length === 0) return none;
  return (
    <ul className="flex flex-col gap-0.5">
      {fields.map((field) => (
        <li key={field.name} className="min-w-0 break-words">
          <span className="font-mono text-xs">{field.name}</span>
          {field.description ? (
            <span className="text-muted-foreground"> · {field.description}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function SpecFacts({ spec }: { spec: WorkflowSpec | null }) {
  const { t } = useI18n();
  const none = t("workflowSpec.none");
  if (!spec) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="workflow-spec-empty">
        {t("workflowSpec.empty")}
      </p>
    );
  }
  const items: Fact[] = [
    {
      label: t("workflowSpec.goal"),
      value: spec.goal ? (
        <span className="break-words">{spec.goal}</span>
      ) : (
        t("workflowSpec.noGoal")
      ),
      testId: "workflow-spec-goal",
    },
    {
      label: t("workflowSpec.inputs"),
      value: fieldValue(spec.inputs, none),
      testId: "workflow-spec-inputs",
    },
    {
      label: t("workflowSpec.outputs"),
      value: fieldValue(spec.outputs, none),
      testId: "workflow-spec-outputs",
    },
    {
      label: t("workflowSpec.delivery"),
      value: spec.delivery ? (
        <span className="break-words">
          {spec.delivery.channel}
          {spec.delivery.destination ? ` · ${spec.delivery.destination}` : ""}
        </span>
      ) : (
        none
      ),
      testId: "workflow-spec-delivery",
    },
    {
      label: t("workflowSpec.questions"),
      value:
        spec.open_questions.length === 0 ? (
          none
        ) : (
          <ul
            className="flex list-disc flex-col gap-0.5 pl-4"
            data-testid="workflow-spec-question-list"
          >
            {spec.open_questions.map((question) => (
              <li key={question} className="break-words">
                {question}
              </li>
            ))}
          </ul>
        ),
      testId: "workflow-spec-questions",
    },
    {
      label: t("workflowSpec.origin"),
      value: t(ORIGIN_KEYS[spec.origin]),
      testId: "workflow-spec-origin",
    },
  ];
  return <FactList items={items} layout="stacked" testId="workflow-spec-facts" />;
}

function SpecDialog({
  open,
  onOpenChange,
  spec,
  pending,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spec: WorkflowSpec | null;
  pending: boolean;
  onSave: (spec: WorkflowSpec) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<SpecForm>(() => specForm(spec));
  useEffect(() => {
    if (open) setForm(specForm(spec));
  }, [open, spec]);
  const set = (field: keyof SpecForm) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const valid = specFormValid(form);
  const changed = specFormChanged(spec ?? emptySpec(), form) || spec === null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("workflowSpec.editTitle")}
      description={t("workflowSpec.editHelp")}
      size="wide"
      submit={{
        label: t("common.save"),
        pending,
        disabled: !valid || !changed,
        testId: "workflow-spec-save",
      }}
      onSubmit={() => {
        if (valid && changed) onSave(specFromForm(spec, form));
      }}
      cancelTestId="workflow-spec-cancel"
      testId="workflow-spec-dialog"
    >
      <TextAreaField
        id="workflow-spec-form-goal"
        label={t("workflowSpec.goal")}
        value={form.goal}
        onChange={set("goal")}
        rows={3}
        error={valid ? null : t("workflowSpec.tooLong")}
      />
      <TextAreaField
        id="workflow-spec-form-inputs"
        label={t("workflowSpec.inputs")}
        help={t("workflowSpec.linesHelp")}
        value={form.inputs}
        onChange={set("inputs")}
        rows={3}
      />
      <TextAreaField
        id="workflow-spec-form-outputs"
        label={t("workflowSpec.outputs")}
        help={t("workflowSpec.linesHelp")}
        value={form.outputs}
        onChange={set("outputs")}
        rows={3}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="workflow-spec-form-channel"
          label={t("workflowSpec.channel")}
          value={form.channel}
          onChange={set("channel")}
        />
        <TextField
          id="workflow-spec-form-destination"
          label={t("workflowSpec.destination")}
          value={form.destination}
          onChange={set("destination")}
        />
      </div>
      <TextAreaField
        id="workflow-spec-form-questions"
        label={t("workflowSpec.questions")}
        help={t("workflowSpec.questionsHelp")}
        value={form.questions}
        onChange={set("questions")}
        rows={3}
      />
    </FormDialog>
  );
}
