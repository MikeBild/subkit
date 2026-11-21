import type { components } from "@cli-core/engine-api/openapi";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/atoms/button";
import { Alert, AlertDescription, AlertTitle } from "@ui/molecules/alert";
import { ArrowRight, Wrench } from "lucide-react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { absolute } from "@/app/links";
import { useSession } from "@/app/session";
import {
  automationActionPermitted,
  automationRepairAction,
} from "@/features/grants/model/automation-state";
import {
  type GrantScopeWarning,
  OPENING_NOTICE_KEYS,
  triggerEnvironments,
} from "@/features/grants/model/grant-context";
import type { ReviewEnvironment } from "@/features/grants/model/review-environment";
import {
  REPAIR_NOTE_KEYS,
  repairReviewHref,
  useStepRepair,
  type WorkflowDiagnosis,
  workflowDiagnosisQuery,
} from "@/features/workflows";
import { useI18n } from "@/lib/i18n-context";

type ScheduleList = components["schemas"]["ScheduleListResponse"];

function grantScheduleQuery(workflowId: string) {
  return {
    queryKey: ["workflow", workflowId, "schedules"],
    queryFn: () => apiCall("get", "/v1/schedules", { query: { workflow_id: workflowId } }),
  };
}

function grantWorkflowQuery(workflowId: string) {
  return {
    queryKey: ["workflow-grant-context", workflowId],
    queryFn: () => apiCall("get", "/v1/workflows/{id}", { path: { id: workflowId } }),
  };
}

function ownSchedules(workflowId: string, list: ScheduleList | undefined) {
  return Array.isArray(list?.schedules)
    ? list.schedules.filter((entry) => entry.workflow_id === workflowId)
    : null;
}

export function useGrantContext(workflowId: string, open: boolean) {
  const session = useSession();
  const authorities = useQuery({
    queryKey: ["workflow-authorities", workflowId, "newest"],
    enabled: open,
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/execution-authorities", {
        path: { id: workflowId },
        query: { limit: 20 },
      }),
  });
  const schedules = useQuery({
    ...grantScheduleQuery(workflowId),
    enabled: open && session.permissions.includes("schedule:read"),
  });
  const workflow = useQuery({ ...grantWorkflowQuery(workflowId), enabled: open });
  return {
    authorities: Array.isArray(authorities.data?.items) ? authorities.data.items : null,
    startedIn: triggerEnvironments(
      ownSchedules(workflowId, schedules.data),
      workflow.data?.webhooks_active,
    ),
    activeVersion: workflow.data?.current_version ?? null,
    webhooksActive: (workflow.data?.webhooks_active ?? 0) > 0,
  };
}

function useEnvironmentWord() {
  const { t } = useI18n();
  return (environment: ReviewEnvironment) =>
    t(environment === "prod" ? "authority.production" : "authority.development");
}

export function GrantScopeWarnings({ warnings }: { warnings: readonly GrantScopeWarning[] }) {
  const { t } = useI18n();
  const word = useEnvironmentWord();
  return (
    <>
      {warnings.map((warning) =>
        warning.kind === "other_environment" ? (
          <Alert key={warning.kind} data-testid="authority-scope-environment">
            <AlertTitle>
              {t("authority.scope.environment.title", { selected: word(warning.selected) })}
            </AlertTitle>
            <AlertDescription>
              {t("authority.scope.environment.description", { runsIn: word(warning.runsIn) })}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert key={warning.kind} data-testid="authority-scope-version">
            <AlertTitle>{t("authority.scope.version.title")}</AlertTitle>
            <AlertDescription>
              {warning.active === null
                ? t("authority.scope.version.first")
                : t("authority.scope.version.description", { active: `v${warning.active}` })}
            </AlertDescription>
          </Alert>
        ),
      )}
    </>
  );
}

export function GrantOpeningNotice({ notice }: { notice: "trial" | "sample" | null }) {
  const { t } = useI18n();
  if (!notice) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="grant-opening-notice">
      {t(OPENING_NOTICE_KEYS[notice])}
    </p>
  );
}

export function useGrantRemedy(
  workflowId: string,
  environment: ReviewEnvironment,
  enabled: boolean,
): { diagnosis: WorkflowDiagnosis; via: "review" | "auto" | "prepare" } | null {
  const session = useSession();
  const { permissions } = session;
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: enabled && permissions.includes("workflow:read"),
  });
  const [entry] = diagnosis.data?.diagnoses ?? [];
  if (!diagnosis.data || !entry) return null;
  const action = automationRepairAction(entry, diagnosis.data.is_current);
  const { via } = action;
  if (via === "chat") return null;
  const permitted = automationActionPermitted(action, {
    write: permissions.includes("workflow:write"),
    run: permissions.includes("workflow:run"),
    chat: permissions.includes("conversation:write"),
  });
  return permitted ? { diagnosis: diagnosis.data, via } : null;
}

export function GrantRemedyAction({
  remedy,
  environment,
  busy,
  onRecheck,
}: {
  remedy: NonNullable<ReturnType<typeof useGrantRemedy>>;
  environment: ReviewEnvironment;
  busy: boolean;
  onRecheck: () => void;
}) {
  const { t } = useI18n();
  if (remedy.via === "prepare")
    return (
      <Button
        type="button"
        disabled={busy}
        onClick={onRecheck}
        data-testid="authority-remedy-prepare"
      >
        {t("diagnosis.prepare")}
      </Button>
    );
  return (
    <DiagnosisRepairAction
      diagnosis={remedy.diagnosis}
      environment={environment}
      via={remedy.via}
      testId="authority-remedy"
    />
  );
}

function DiagnosisRepairAction({
  diagnosis,
  environment,
  via,
  testId,
}: {
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  via: "review" | "auto";
  testId: string;
}) {
  const entry = diagnosis.diagnoses[0];
  if (!entry) return null;
  return (
    <DiagnosisRepairButton
      entry={entry}
      diagnosis={diagnosis}
      environment={environment}
      via={via}
      testId={testId}
    />
  );
}

function DiagnosisRepairButton({
  entry,
  diagnosis,
  environment,
  via,
  testId,
}: {
  entry: WorkflowDiagnosis["diagnoses"][number];
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  via: "review" | "auto";
  testId: string;
}) {
  const { t } = useI18n();
  const repair = useStepRepair({
    entry,
    diagnosis,
    environment,
    onNote: (note) => toast(t(REPAIR_NOTE_KEYS[note])),
  });
  if (via === "review")
    return (
      <Button asChild>
        <a href={absolute(repairReviewHref(diagnosis.workflow_id))} data-testid={testId}>
          {t("remedy.reviewRepair")}
          <ArrowRight data-icon="inline-end" />
        </a>
      </Button>
    );
  if (!entry.fixer) return null;
  return (
    <Button
      type="button"
      disabled={repair.isPending}
      onClick={() => entry.fixer && repair.mutate(entry.fixer)}
      data-testid={testId}
    >
      <Wrench data-icon="inline-start" />
      {t("diagnosis.repair")}
    </Button>
  );
}
