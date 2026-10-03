import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Wrench } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute } from "@/app/links";
import { useSession } from "@/app/session";
import {
  REPAIR_NOTE_KEYS,
  repairReviewHref,
  useStepRepair,
  type WorkflowDiagnosis,
  workflowDiagnosisQuery,
} from "@/components/cockpit/workflow-diagnosis";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { automationActionPermitted, automationRepairAction } from "@/lib/automation-state";
import {
  type GrantScopeWarning,
  OPENING_NOTICE_KEYS,
  suggestionNote,
  triggerEnvironments,
} from "@/lib/grant-context";
import { useI18n } from "@/lib/i18n-context";
import type { ReviewEnvironment } from "@/lib/review-environment";
import type { WorkflowAuthorityList, WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

type ScheduleList = components["schemas"]["ScheduleListResponse"];

/**
 * What the approval dialog has to know beyond the review itself: the approvals
 * that already exist, where the workflow is started, and which version runs.
 * Read only while the dialog is open; every read may be missing — a reader
 * without the permission simply gets no notice built on it.
 */
export function useGrantContext(workflowId: string, open: boolean) {
  const session = useSession();
  const id = encodeURIComponent(workflowId);
  const authorities = useQuery({
    // Under the approvals' own key, so every act that changes them refreshes it.
    queryKey: ["workflow-authorities", workflowId, "newest"],
    enabled: open,
    queryFn: () =>
      apiRequest<WorkflowAuthorityList>(`/v1/workflows/${id}/execution-authorities?limit=20`),
  });
  const schedules = useQuery({
    queryKey: ["workflow", workflowId, "schedules"],
    enabled: open && session.permissions.includes("schedule:read"),
    queryFn: () => apiRequest<ScheduleList>(`/v1/schedules?workflow_id=${id}`),
  });
  const workflow = useQuery({
    queryKey: ["workflow-grant-context", workflowId],
    enabled: open,
    queryFn: () =>
      apiRequest<{ current_version: number | null; webhooks_active?: number | null }>(
        `/v1/workflows/${id}`,
      ),
  });
  const own = Array.isArray(schedules.data?.schedules)
    ? schedules.data.schedules.filter((entry) => entry.workflow_id === workflowId)
    : null;
  return {
    authorities: Array.isArray(authorities.data?.items) ? authorities.data.items : null,
    startedIn: triggerEnvironments(own, workflow.data?.webhooks_active),
    activeVersion: workflow.data?.current_version ?? null,
  };
}

function useEnvironmentWord() {
  const { t } = useI18n();
  return (environment: ReviewEnvironment) =>
    t(environment === "prod" ? "authority.production" : "authority.development");
}

/** The scope of the approval, where it is not the ordinary one. */
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

/** Where the suggested limits come from, in one line beside the fields. */
export function GrantSuggestionNote({ review }: { review: WorkflowAuthorityPreview }) {
  const { t } = useI18n();
  const note = suggestionNote(review.suggested_bounds_basis);
  if (!note) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="authority-suggestion">
      {t(note.key, note.values)}
    </p>
  );
}

/** What the press that opens the dialog sets off — said beside the opener. */
export function GrantOpeningNotice({ notice }: { notice: "trial" | "sample" | null }) {
  const { t } = useI18n();
  if (!notice) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="grant-opening-notice">
      {t(OPENING_NOTICE_KEYS[notice])}
    </p>
  );
}

/**
 * The act that removes what keeps the reviewed version from being approved —
 * the gate diagnosis' own, the same one the workflow page offers. Null when
 * the only way on is an author (the dialog's chat action already is that) or
 * the reader may not perform it.
 */
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

/**
 * The remedy as the dialog's filled action. A missing trial run is repeated by
 * the dialog itself — its own re-check runs the trial and reads the review
 * again in place; a repair is the diagnosis block's own act.
 */
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
      <Button disabled={busy} onClick={onRecheck} data-testid="authority-remedy-prepare">
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

/**
 * A step's repair as the approval dialog's remedy: the same act as the step's
 * own button on the workflow page. What a repair request answers is said as a
 * toast — a dialog footer has no room for a sentence.
 */
function DiagnosisRepairAction({
  diagnosis,
  environment,
  via,
  testId,
}: {
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  /** `review`: the repair is already filed; `auto`: the engine can compute one. */
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
      disabled={repair.isPending}
      onClick={() => entry.fixer && repair.mutate(entry.fixer)}
      data-testid={testId}
    >
      <Wrench data-icon="inline-start" />
      {t("diagnosis.repair")}
    </Button>
  );
}
