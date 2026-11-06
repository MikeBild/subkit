import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type ApiResponse, apiCall } from "@/api/call";
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
import { formFields, inputForm } from "@/lib/workflow-inputs";

type RunOutcome = ApiResponse<"/v1/executions", "post">;

type Failure =
  | { kind: "connector"; environment: RunEnvironment; connector: UnavailableConnector }
  | { kind: "legacy"; steps: string[] }
  | { kind: "approval"; environment: RunEnvironment }
  | { kind: "failed"; executionId: string | null };

interface RunWording {
  title: string;
  intro: string;
  submit: string;
  started: string;
  refused: string;
  fields: Record<string, { title: string; description: string }>;
}

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
  openOnAnchor,
  wording,
}: {
  wording?: RunWording;
  quiet?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  approvedVersion?: number | null;
  triggerLabel?: string;
  triggerTestId?: string;
  openRequest?: number;
  openOnAnchor?: string;
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
  const anchored = useRef(false);
  useEffect(() => {
    if (!openOnAnchor || anchored.current || disabled) return;
    if (window.location.hash !== `#${openOnAnchor}`) return;
    anchored.current = true;
    setOpen(true);
  }, [openOnAnchor, disabled]);
  const [values, setValues] = useState<SchemaValues | null>(null);
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const schema = useQuery({
    queryKey: ["workflow", workflowId, "input-schema"],
    enabled: open,
    queryFn: () => apiCall("get", "/v1/workflows/{id}/input-schema", { path: { id: workflowId } }),
  });
  const form = inputForm(schema.data?.schema ?? null);
  const fields = formFields(form).map((field) => {
    const own = wording?.fields[field.name];
    return own ? { ...field, title: own.title, description: own.description } : field;
  });
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
      toast.success(wording?.started ?? t("run.startedToast"));
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

  const failureFix =
    failure?.kind === "connector" && !wording ? connectorFix(failure.connector) : null;
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
      title={wording?.title ?? t("run.title", { name: workflowName })}
      size="wide"
      description={
        wording
          ? wording.intro
          : liveEnvironment && approvedVersion != null
            ? t("run.consequenceVersion", { version: approvedVersion })
            : t(liveEnvironment ? "run.consequenceLive" : "run.consequencePreview")
      }
      submit={{
        label: run.isPending
          ? t("run.running")
          : (wording?.submit ?? t(liveEnvironment ? "run.action" : "run.previewAction")),
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
              {wording
                ? wording.refused
                : failure.kind === "connector"
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
            {!wording && failure.kind === "failed" && failure.executionId && (
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
