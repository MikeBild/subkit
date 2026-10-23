import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { absolute, runHref } from "@/app/links";
import { ActionButton, FormDialog, SchemaForm } from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { buildFormSchemaInput, formValuesFromInput, type SchemaValues } from "@/lib/schema-form";
import { formFields, type InputSchemaSource, inputForm } from "@/lib/workflow-inputs";

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
  openRequest,
}: {
  quiet?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  approvedVersion?: number | null;
  triggerLabel?: string;
  triggerTestId?: string;
  openRequest?: number;
  workflowId: string;
  workflowName: string;
  liveEnvironment: RunEnvironment | null | undefined;
}) {
  const { t } = useI18n();
  const sheets = useOpenRunSheet();
  const [open, setOpen] = useState(false);
  const requested = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (openRequest === undefined || openRequest === requested.current) return;
    requested.current = openRequest;
    if (!disabled) setOpen(true);
  }, [openRequest, disabled]);
  const [values, setValues] = useState<SchemaValues | null>(null);
  const [checked, setChecked] = useState(false);
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
  const filled = values ?? formValuesFromInput(form, undefined);
  const built = buildFormSchemaInput(form, filled);
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
          ...(built.input !== undefined ? { input: built.input } : {}),
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
      setValues(null);
      setChecked(false);
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
        if (!next) {
          setFailure(null);
          setChecked(false);
        }
      }}
      trigger={
        openRequest === undefined ? (
          <Button
            variant={quiet || disabled ? "outline" : "default"}
            disabled={disabled}
            data-testid={triggerTestId}
          >
            {quiet ? null : <Play aria-hidden="true" />}
            {triggerLabel ?? t("run.action")}
          </Button>
        ) : undefined
      }
      title={t("run.title", { name: workflowName })}
      size="wide"
      description={
        liveEnvironment && approvedVersion != null
          ? t("run.consequenceVersion", { version: approvedVersion })
          : t(liveEnvironment ? "run.consequenceLive" : "run.consequencePreview")
      }
      submit={{
        label: run.isPending
          ? t("run.running")
          : t(liveEnvironment ? "run.action" : "run.previewAction"),
        pending: run.isPending,
        disabled: liveEnvironment === undefined || repeats || schema.isPending,
        testId: "workflow-run-submit",
      }}
      onSubmit={() => {
        setChecked(true);
        if (built.errors.length === 0) run.mutate();
      }}
      cancelTestId="workflow-run-cancel"
      testId="workflow-run-dialog"
    >
      {schema.data?.source === "synthesized" && fields.length > 0 ? (
        <p className="text-xs text-muted-foreground">{t("run.schemaSynthesized")}</p>
      ) : null}
      <SchemaForm
        fields={fields}
        values={filled}
        onChange={(next) => setValues(next)}
        errors={checked ? built.errors : []}
        empty={schema.isPending ? undefined : t("run.noInputs")}
        testId="workflow-run-inputs"
      />

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
    </FormDialog>
  );
}
