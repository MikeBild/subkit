import { useMutation, useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/api/client";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import {
  buildInput,
  type InputSchemaSource,
  inputFields,
  missingRequired,
} from "@/lib/workflow-inputs";

type Environment = "dev" | "prod";

interface InputSchemaResponse {
  source: InputSchemaSource;
  schema: Record<string, unknown> | null;
}

interface RunOutcome {
  execution?: { id?: string; status?: string };
  status?: string;
}

/**
 * Runs the workflow that is actually stored, in a chosen environment — as
 * opposed to the test run, which executes a temporary copy. Production is
 * never one click away: it takes a stated confirmation first.
 */
export function RunWorkflowDialog({
  workflowId,
  workflowName,
  version,
}: {
  workflowId: string;
  workflowName: string;
  version: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [environment, setEnvironment] = useState<Environment>("dev");
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const schema = useQuery({
    queryKey: ["workflow", workflowId, "input-schema"],
    enabled: open,
    queryFn: () =>
      apiRequest<InputSchemaResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/input-schema`,
      ),
  });
  const fields = inputFields(schema.data?.schema ?? null);
  const missing = missingRequired(fields, values);

  const run = useMutation({
    mutationFn: () =>
      apiRequest<RunOutcome>("/v1/executions", {
        method: "POST",
        // The environment travels as a header; the run body has no field for it.
        headers: { "x-subkit-environment": environment },
        body: JSON.stringify({
          source: "saved",
          workflow_id: workflowId,
          ...(fields.length > 0 ? { input: buildInput(fields, values) } : {}),
        }),
      }),
    onSuccess: (result) => {
      setConfirming(false);
      const status = result.execution?.status ?? result.status;
      // Engine statuses are English identifiers; they get a word first.
      setOutcome(status ? statusLabel(t, status) : t("run.started"));
    },
    onError: (error) => {
      setConfirming(false);
      setOutcome(error instanceof Error ? error.message : t("run.failed"));
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setConfirming(false);
          setOutcome(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="workflow-run-open">
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
          <Select value={environment} onValueChange={(next) => setEnvironment(next as Environment)}>
            <SelectTrigger id="workflow-run-environment" data-testid="workflow-run-environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="dev" data-testid="workflow-run-environment-dev">
                  {t("run.environment.dev")}
                </SelectItem>
                <SelectItem value="prod" data-testid="workflow-run-environment-prod">
                  {t("run.environment.prod")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {fields.length > 0 && (
          <div className="grid gap-3" data-testid="workflow-run-inputs">
            {schema.data?.source === "synthesized" && (
              <p className="text-xs text-muted-foreground">{t("run.schemaSynthesized")}</p>
            )}
            {fields.map((field, index) => (
              <Field key={field.name}>
                <FieldLabel htmlFor={`workflow-run-input-${index}`}>
                  {field.name}
                  {field.required && <span aria-hidden="true"> *</span>}
                  <Badge variant="outline" className="ml-2 font-normal">
                    {field.type}
                  </Badge>
                </FieldLabel>
                <Input
                  id={`workflow-run-input-${index}`}
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                  placeholder={field.description ?? ""}
                  data-testid={`workflow-run-input-${index}`}
                />
              </Field>
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
            {t("run.outcome", { outcome })}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" data-testid="workflow-run-cancel" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={run.isPending || missing.length > 0}
            data-testid="workflow-run-submit"
            onClick={() => {
              if (environment === "prod" && !confirming) {
                setConfirming(true);
                return;
              }
              run.mutate();
            }}
          >
            {run.isPending
              ? t("run.running")
              : environment === "prod" && !confirming
                ? t("run.reviewProd")
                : t("run.action")}
          </Button>
        </DialogFooter>
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="workflow-run-missing">
            {t("run.missingInputs", { fields: missing.join(", ") })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
