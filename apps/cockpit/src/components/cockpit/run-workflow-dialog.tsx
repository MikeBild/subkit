import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import { absolute, runHref } from "@/app/links";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  blockingConnector,
  connectorFix,
  connectorLabel,
  defaultEnvironment,
  legacyRefusal,
  RUN_ENVIRONMENTS,
  type RunEnvironment,
  refusedConnector,
  runPreviewKey,
  type UnavailableConnector,
} from "@/lib/run-availability";
import { statusLabel } from "@/lib/status-label";
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

function refusedAgain(failure: Failure | null, environment: RunEnvironment | null): boolean {
  if (!failure || failure.kind === "failed") return false;
  return failure.kind === "legacy" || failure.environment === environment;
}

function useRunAvailability(
  workflowId: string,
  versionId: string | null,
  enabled: boolean,
): { settled: boolean; blocked: Record<RunEnvironment, UnavailableConnector | null> } {
  const previews = useQueries({
    queries: RUN_ENVIRONMENTS.map((environment) => ({
      queryKey: runPreviewKey(workflowId, versionId ?? "", environment),
      enabled: enabled && versionId !== null,
      retry: false,
      queryFn: () =>
        apiRequest<unknown>(
          `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId ?? "")}/authority-preview?environment=${environment}`,
        ),
    })),
  });
  return {
    settled: versionId === null || previews.every((preview) => !preview.isPending),
    blocked: {
      dev: blockingConnector(previews[0]?.data),
      prod: blockingConnector(previews[1]?.data),
    },
  };
}

const UNSET = "__unset";

function InputFieldControl({
  field,
  index,
  value,
  invalid,
  onChange,
}: {
  field: InputField;
  index: number;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const id = `workflow-run-input-${index}`;
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
  version,
  versionId,
  quiet = false,
}: {
  quiet?: boolean;
  workflowId: string;
  workflowName: string;
  version: string | null;
  versionId: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<RunEnvironment | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<{ status: string; executionId: string | null } | null>(
    null,
  );
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
  const availability = useRunAvailability(workflowId, versionId, open);
  const environment =
    chosen ?? (availability.settled ? defaultEnvironment(availability.blocked) : null);
  const blockedHere = environment ? availability.blocked[environment] : null;

  const environmentWord = (value: RunEnvironment) => t(`run.environment.${value}`);
  const blockedSentence = (value: RunEnvironment, connector: UnavailableConnector) => {
    const key = blockedSentenceKey(connector.reason);
    return key
      ? t(key, { environment: environmentWord(value), connector: connectorLabel(connector) })
      : t("run.failed");
  };

  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: (target: RunEnvironment) =>
      apiRequest<RunOutcome>("/v1/executions", {
        method: "POST",
        headers: { "x-subkit-environment": target },
        body: JSON.stringify({
          source: "saved",
          workflow_id: workflowId,
          ...(buildFormInput(form, filled) !== undefined
            ? { input: buildFormInput(form, filled) }
            : {}),
        }),
      }),
    onSuccess: (result) => {
      setConfirming(false);
      setFailure(null);
      void invalidateWorkflowAutomation(queryClient, workflowId);
      for (const queryKey of [
        ["workflow-recent-runs", workflowId],
        ["workflow-latest-failed-run", workflowId],
        ["workflow", workflowId],
      ])
        void queryClient.invalidateQueries({ queryKey });
      setOutcome({
        status: result.status ? statusLabel(t, result.status) : t("run.started"),
        executionId: result.execution_id ?? null,
      });
    },
    onError: (error, target) => {
      setConfirming(false);
      setOutcome(null);
      const refused = refusedConnector(error);
      if (refused) {
        setFailure({
          kind: "connector",
          environment: refused.environment ?? target,
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
        setFailure({ kind: "approval", environment: target });
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
  const repeats = refusedAgain(failure, environment);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setConfirming(false);
          setOutcome(null);
          setFailure(null);
          setChosen(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={quiet ? "outline" : "default"} data-testid="workflow-run-open">
          <Play data-icon="inline-start" />
          {t("run.action")}
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="workflow-run-dialog">
        <DialogHeader>
          <DialogTitle>{t("run.title", { name: workflowName })}</DialogTitle>
          <DialogDescription>
            {version ? t("run.savedVersion", { version }) : t("run.savedVersionUnknown")}
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="workflow-run-environment">{t("run.environment")}</FieldLabel>
          <Select
            value={environment ?? ""}
            onValueChange={(next) => {
              setChosen(next as RunEnvironment);
              setConfirming(false);
              setFailure((current) => (current?.kind === "legacy" ? current : null));
            }}
          >
            <SelectTrigger id="workflow-run-environment" data-testid="workflow-run-environment">
              <SelectValue placeholder={t("common.loading")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RUN_ENVIRONMENTS.map((value) => {
                  const blocked = availability.blocked[value];
                  return (
                    <SelectItem
                      key={value}
                      value={value}
                      disabled={blocked !== null}
                      data-testid={`workflow-run-environment-${value}`}
                    >
                      {blocked ? blockedSentence(value, blocked) : environmentWord(value)}
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            </SelectContent>
          </Select>
          {RUN_ENVIRONMENTS.map((value) => {
            const blocked = availability.blocked[value];
            if (!blocked) return null;
            const fix = connectorFix(blocked);
            return (
              <p
                key={value}
                className="text-sm text-muted-foreground"
                data-testid={`workflow-run-blocked-${value}`}
              >
                {blockedSentence(value, blocked)}.{" "}
                {fix && (
                  <a
                    href={absolute(fix.href)}
                    className="underline underline-offset-4"
                    data-testid={`workflow-run-blocked-${value}-remedy`}
                  >
                    {t(fix.labelKey)}
                  </a>
                )}
              </p>
            );
          })}
        </Field>

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

        {confirming && environment === "prod" && (
          <Alert variant="destructive" data-testid="workflow-run-confirm">
            <AlertTitle>{t("run.confirmTitle")}</AlertTitle>
            <AlertDescription>
              {t("run.confirmDescription", { name: workflowName })}
            </AlertDescription>
          </Alert>
        )}

        {outcome && (
          <p className="text-sm" data-testid="workflow-run-outcome">
            {t("run.outcome", { outcome: outcome.status })}{" "}
            {outcome.executionId && (
              <a
                href={absolute(runHref(outcome.executionId))}
                className="underline underline-offset-4"
                data-testid="workflow-run-outcome-link"
              >
                {t("run.failedWithLink")}
              </a>
            )}
          </p>
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

        <DialogFooter>
          <Button variant="ghost" data-testid="workflow-run-cancel" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              run.isPending ||
              missing.length > 0 ||
              invalid.length > 0 ||
              environment === null ||
              blockedHere !== null ||
              repeats
            }
            data-testid="workflow-run-submit"
            onClick={() => {
              if (!environment) return;
              if (environment === "prod" && !confirming) {
                setConfirming(true);
                return;
              }
              run.mutate(environment);
            }}
          >
            {run.isPending
              ? t("run.running")
              : environment === "prod" && !confirming
                ? t("run.reviewProd")
                : t("run.action")}
          </Button>
        </DialogFooter>
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
      </DialogContent>
    </Dialog>
  );
}
