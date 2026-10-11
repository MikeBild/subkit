import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { absolute, runHref } from "@/app/links";
import { ActionButton, FormDialog } from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { useI18n } from "@/lib/i18n-context";
import {
  approvalRefusal,
  blockedSentenceKey,
  connectorFix,
  connectorLabel,
  legacyRefusal,
  type RunEnvironment,
  refusedConnector,
  type UnavailableConnector,
} from "@/lib/run-availability";
import {
  buildFormInput,
  formFields,
  type InputField,
  type InputSchemaSource,
  initialInputValues,
  inputControl,
  inputForm,
  inputItemTypeKey,
  inputSampleText,
  inputTypeKey,
  invalidInputs,
  missingRequired,
} from "@/lib/workflow-inputs";

interface InputSchemaResponse {
  source: InputSchemaSource;
  schema: Record<string, unknown> | null;
}

interface RunOutcome {
  execution_id?: string;
  status?: string;
}

type Failure =
  | { kind: "connector"; environment: RunEnvironment; connector: UnavailableConnector }
  | { kind: "legacy"; steps: string[] }
  | { kind: "approval"; environment: RunEnvironment }
  | { kind: "failed"; executionId: string | null };

const ENGINE_DEFAULT_ENVIRONMENT: RunEnvironment = "dev";

const UNSET = "__unset";

export function InputFieldControl({
  field,
  index,
  value,
  invalid,
  onChange,
  idPrefix = "workflow-run-input",
}: {
  field: InputField;
  index: number;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  idPrefix?: string;
}) {
  const { t } = useI18n();
  const id = `${idPrefix}-${index}`;
  const control = inputControl(field);
  const sample = inputSampleText(field);
  const item = inputItemTypeKey(field);
  const typeWord = item
    ? t("input.type.arrayOf", { type: t(inputTypeKey(field)), item: t(item) })
    : t(inputTypeKey(field));
  const options =
    control === "boolean"
      ? [
          { value: "true", label: t("common.yes") },
          { value: "false", label: t("common.no") },
        ]
      : (field.options ?? []).map((option) => ({ value: String(option), label: String(option) }));
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>
        {field.name}
        {field.required && <span aria-hidden="true"> *</span>}
        <Badge variant="outline" className="ml-2 font-normal">
          {typeWord}
        </Badge>
      </FieldLabel>
      {control === "select" || control === "boolean" ? (
        <Select
          value={value === "" ? (field.required ? "" : UNSET) : value}
          onValueChange={(next) => onChange(next === UNSET ? "" : next)}
        >
          <SelectTrigger id={id} aria-invalid={invalid} data-testid={id}>
            <SelectValue placeholder={sample ?? ""} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {field.required ? null : (
                <SelectItem value={UNSET} data-testid={`${id}-unset`}>
                  {t("input.unset")}
                </SelectItem>
              )}
              {options.map((option, optionIndex) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  data-testid={`${id}-option-${optionIndex}`}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : control === "json" ? (
        <Textarea
          id={id}
          rows={3}
          className="font-mono text-xs"
          value={value}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          placeholder={sample ?? (field.type === "array" ? "[]" : field.union ? "" : "{}")}
          data-testid={id}
        />
      ) : (
        <Input
          id={id}
          type={control === "number" ? "number" : "text"}
          inputMode={control === "number" ? "decimal" : undefined}
          step={field.type === "integer" ? 1 : control === "number" ? "any" : undefined}
          value={value}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          placeholder={sample ?? ""}
          data-testid={id}
        />
      )}
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  );
}

export function RunWorkflowDialog({
  workflowId,
  workflowName,
  liveEnvironment,
  quiet = false,
  disabled = false,
  disabledReason,
  approvedVersion,
  triggerLabel,
  triggerTestId = "workflow-run-open",
}: {
  quiet?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  approvedVersion?: number | null;
  triggerLabel?: string;
  triggerTestId?: string;
  workflowId: string;
  workflowName: string;
  liveEnvironment: RunEnvironment | null | undefined;
}) {
  const { t } = useI18n();
  const sheets = useOpenRunSheet();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);

  const schema = useQuery({
    queryKey: ["workflow", workflowId, "input-schema"],
    enabled: open,
    queryFn: () =>
      apiRequest<InputSchemaResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/input-schema`,
      ),
  });
  const form = inputForm(schema.data?.schema ?? null);
  const fields = formFields(form);
  const filled = { ...initialInputValues(fields), ...values };
  const missing = missingRequired(fields, filled);
  const invalid = invalidInputs(fields, filled);
  const environment = liveEnvironment ?? ENGINE_DEFAULT_ENVIRONMENT;

  const environmentWord = (value: RunEnvironment) => t(`run.environment.${value}`);
  const blockedSentence = (value: RunEnvironment, connector: UnavailableConnector) => {
    const key = blockedSentenceKey(connector.reason);
    return key
      ? t(key, { environment: environmentWord(value), connector: connectorLabel(connector) })
      : t("run.failed");
  };

  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () =>
      apiRequest<RunOutcome>("/v1/executions", {
        method: "POST",
        ...(liveEnvironment ? { headers: { "x-subkit-environment": liveEnvironment } } : {}),
        body: JSON.stringify({
          source: "saved",
          workflow_id: workflowId,
          ...(buildFormInput(form, filled) !== undefined
            ? { input: buildFormInput(form, filled) }
            : {}),
        }),
      }),
    onSuccess: (result) => {
      setFailure(null);
      void invalidateWorkflowAutomation(queryClient, workflowId);
      for (const queryKey of [
        ["workflow-recent-runs", workflowId],
        ["workflow-latest-failed-run", workflowId],
        ["workflow", workflowId],
      ])
        void queryClient.invalidateQueries({ queryKey });
      setOpen(false);
      setValues({});
      toast.success(t("run.startedToast"));
      if (result.execution_id) sheets.run(result.execution_id);
    },
    onError: (error) => {
      const refused = refusedConnector(error);
      if (refused) {
        setFailure({
          kind: "connector",
          environment: refused.environment ?? environment,
          connector: refused,
        });
        return;
      }
      const legacy = legacyRefusal(error);
      if (legacy) {
        setFailure({ kind: "legacy", steps: legacy.steps });
        return;
      }
      if (approvalRefusal(error)) {
        setFailure({ kind: "approval", environment });
        return;
      }
      const details = (error as { details?: Record<string, unknown> | null }).details;
      setFailure({
        kind: "failed",
        executionId: typeof details?.execution_id === "string" ? details.execution_id : null,
      });
    },
  });

  const failureFix = failure?.kind === "connector" ? connectorFix(failure.connector) : null;
  const repeats = failure !== null && failure.kind !== "failed";

  if (disabled)
    return (
      <ActionButton disabled disabledReason={disabledReason} testId={triggerTestId}>
        {triggerLabel ?? t("run.action")}
      </ActionButton>
    );

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFailure(null);
      }}
      trigger={
        <Button
          variant={quiet || disabled ? "outline" : "default"}
          disabled={disabled}
          data-testid={triggerTestId}
        >
          {triggerLabel ?? t("run.action")}
        </Button>
      }
      title={t("run.title", { name: workflowName })}
      description={
        liveEnvironment && approvedVersion != null
          ? t("run.consequenceVersion", { version: approvedVersion })
          : t(liveEnvironment ? "run.consequenceLive" : "run.consequencePreview")
      }
      submit={{
        label: run.isPending ? t("run.running") : t("run.action"),
        pending: run.isPending,
        disabled:
          liveEnvironment === undefined || missing.length > 0 || invalid.length > 0 || repeats,
        testId: "workflow-run-submit",
      }}
      onSubmit={() => run.mutate()}
      cancelTestId="workflow-run-cancel"
      testId="workflow-run-dialog"
    >
      {fields.length > 0 && (
        <div className="grid gap-3" data-testid="workflow-run-inputs">
          {schema.data?.source === "synthesized" && (
            <p className="text-xs text-muted-foreground">{t("run.schemaSynthesized")}</p>
          )}
          {fields.map((field, index) => (
            <InputFieldControl
              key={field.name}
              field={field}
              index={index}
              value={filled[field.name] ?? ""}
              invalid={invalid.includes(field.name)}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
        </div>
      )}

      {failure && (
        <Alert variant="destructive" data-testid="workflow-run-error">
          <AlertDescription>
            <p>
              {failure.kind === "connector"
                ? `${blockedSentence(failure.environment, failure.connector)}.`
                : failure.kind === "legacy"
                  ? failure.steps.length > 0
                    ? t("run.legacySteps", { steps: failure.steps.join(", ") })
                    : t("run.legacy")
                  : failure.kind === "approval"
                    ? t("run.approvalMissing", {
                        environment: environmentWord(failure.environment),
                      })
                    : t("run.failed")}
            </p>
            {failureFix && (
              <a
                href={absolute(failureFix.href)}
                className="font-medium underline underline-offset-4"
                data-testid="workflow-run-error-remedy"
              >
                {t(failureFix.labelKey)}
              </a>
            )}
            {failure.kind === "failed" && failure.executionId && (
              <a
                href={absolute(runHref(failure.executionId))}
                className="font-medium underline underline-offset-4"
                data-testid="workflow-run-error-run"
              >
                {t("run.failedWithLink")}
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
      {repeats && (
        <p className="text-xs text-muted-foreground" data-testid="workflow-run-repeats">
          {t("run.refusedAgain")}
        </p>
      )}
      {missing.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="workflow-run-missing">
          {t("run.missingInputs", { fields: missing.join(", ") })}
        </p>
      )}
      {invalid.length > 0 && (
        <p className="text-xs text-destructive" data-testid="workflow-run-invalid">
          {t("input.invalid", { fields: invalid.join(", ") })}
        </p>
      )}
    </FormDialog>
  );
}
