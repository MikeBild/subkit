import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, attentionHref, chatNewHref, routerTarget } from "@/app/links";
import { useSession } from "@/app/session";
import { ActionMenu, type ActionMenuItem, DataState, Section } from "@/components/cockpit/patterns";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { AUTOMATION_REFRESH_MS, invalidateWorkflowAutomation } from "@/lib/automation-queries";
import {
  diagnosisActs,
  diagnosisCauseKey,
  diagnosisNote,
  diagnosisRepairable,
  type RepairStatus,
} from "@/lib/gate-diagnosis";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { catalogLabel, LabelText } from "@/lib/machine-label";

export type WorkflowDiagnosis = components["schemas"]["WorkflowDiagnosis"];
type GateDiagnosis = components["schemas"]["GateDiagnosis"];
type RepairResponse = components["schemas"]["ProposeWorkflowRepairResponse"];
type PrepareResponse = { prepared: boolean; reason?: string };
export type RepairNote = RepairStatus | "failed";

export function workflowDiagnosisQuery(workflowId: string, environment: "dev" | "prod" | null) {
  return {
    queryKey: ["workflow-diagnosis", workflowId, environment],
    queryFn: () =>
      apiRequest<WorkflowDiagnosis>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/diagnosis?environment=${environment}`,
      ),
    retry: false,
    refetchInterval: AUTOMATION_REFRESH_MS,
  } as const;
}

export const REPAIR_NOTE_KEYS: Record<RepairNote, TranslationKey> = {
  failed: "diagnosis.repairFailed",
  rejected: "diagnosis.repairRejected",
  applied: "diagnosis.repairApplied",
  stale: "diagnosis.repairStale",
};

function preparedKey(result: PrepareResponse): TranslationKey {
  if (result.prepared) return "diagnosis.prepared";
  if (result.reason === "preparation_in_flight") return "diagnosis.prepareInFlight";
  if (result.reason === "input_required") return "diagnosis.prepareNeedsSample";
  return "diagnosis.prepareNotRun";
}

export const repairReviewHref = (workflowId: string) =>
  attentionHref({ review: `workflow:${workflowId}` });

export function useStepRepair({
  entry,
  diagnosis,
  environment,
  onNote,
}: {
  entry: GateDiagnosis;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  onNote: (note: RepairNote) => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const workflowId = diagnosis.workflow_id;
  return useMutation({
    mutationFn: (fixer: NonNullable<GateDiagnosis["fixer"]>) =>
      apiRequest<RepairResponse>(`/v1/workflows/${encodeURIComponent(workflowId)}/repairs`, {
        method: "POST",
        body: JSON.stringify({ step_id: entry.subject.step_id, fixer, environment }),
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["run-open-repair", workflowId] });
      if (result.status === "proposed") {
        void navigate(routerTarget(repairReviewHref(workflowId)));
        return;
      }
      onNote(diagnosisNote(result.status));
      void client.invalidateQueries({ queryKey: ["workflow-diagnosis", workflowId] });
    },
    onError: () => onNote("failed"),
  });
}

export function WorkflowGateDiagnosis({
  workflowId,
  environment,
  onOpenApproval,
  ownRetry,
  rejectedRepairs,
  onRepairRejected,
}: {
  workflowId: string;
  environment: "dev" | "prod" | null;
  onOpenApproval?: () => void;
  ownRetry: boolean;
  rejectedRepairs: readonly string[];
  onRepairRejected: (stepId: string) => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const canRead = session.permissions.includes("workflow:read");
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: canRead && environment !== null,
    retryOnMount: false,
  });
  if (!canRead || environment === null) return null;
  if (diagnosis.error)
    return (
      <DataState
        state="error"
        line={t("diagnosis.loadFailed")}
        onRetry={ownRetry ? () => void diagnosis.refetch() : undefined}
        testId="workflow-diagnosis-failed"
      />
    );
  const entries = diagnosis.data?.diagnoses ?? [];
  if (!diagnosis.data || entries.length === 0) return null;
  const answer = diagnosis.data;
  return (
    <div data-testid="workflow-diagnosis">
      <Section label={t("diagnosis.title")}>
        <ul className="flex flex-col gap-2">
          {entries.map((entry, index) => (
            <DiagnosisItem
              key={`${entry.subject.step_id}:${entry.code}:${entry.fixer ?? ""}`}
              index={index}
              entry={entry}
              diagnosis={answer}
              environment={environment}
              showRun={
                entries.findIndex(
                  (other) => other.evidence.execution_id === entry.evidence.execution_id,
                ) === index
              }
              onRepairRejected={() => onRepairRejected(entry.subject.step_id)}
            />
          ))}
        </ul>
        <DiagnosisActions
          diagnosis={answer}
          environment={environment}
          rejectedRepairs={rejectedRepairs}
          onOpenApproval={onOpenApproval}
        />
      </Section>
    </div>
  );
}

function DiagnosisItem({
  entry,
  diagnosis,
  environment,
  index,
  showRun,
  onRepairRejected,
}: {
  entry: GateDiagnosis;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  index: number;
  showRun: boolean;
  onRepairRejected: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const sheets = useOpenRunSheet();
  const testId = `workflow-diagnosis-${index}`;
  const [note, setNote] = useState<RepairNote | null>(null);
  const repair = useStepRepair({
    entry,
    diagnosis,
    environment,
    onNote: (value) => {
      setNote(value);
      if (value === "rejected") onRepairRejected();
    },
  });

  const causeKey = diagnosisCauseKey(entry.code);
  const cause = catalogLabel(entry.code, causeKey, t);
  const canRepair = diagnosisRepairable(entry, diagnosis.is_current, {
    write: session.permissions.includes("workflow:write"),
  });
  const offersRepair = canRepair && !entry.candidate_id;
  const runId = showRun ? entry.evidence.execution_id : undefined;
  const acts: ActionMenuItem[] = [
    ...(offersRepair
      ? [
          {
            label: t("diagnosis.repair"),
            disabled: repair.isPending,
            onSelect: () => entry.fixer && repair.mutate(entry.fixer),
            testId: `${testId}-repair`,
          },
        ]
      : []),
    ...(runId
      ? [{ label: t("remedy.openRun"), onSelect: () => sheets.run(runId), testId: `${testId}-run` }]
      : []),
  ];
  const sentence = (key: TranslationKey) => (
    <p className="text-sm text-muted-foreground" data-testid={`${testId}-note`}>
      {t(key)}
    </p>
  );

  return (
    <li
      className="flex flex-col gap-1 rounded-lg border border-amber-500/40 px-3 py-2"
      data-testid={testId}
      data-code={entry.code}
      data-remedy={entry.remedy_kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm" data-testid={`${testId}-cause`}>
          <span className="font-medium">
            {t("diagnosis.step", { step: entry.subject.step_id })}
          </span>
          {" · "}
          {entry.reason ? (
            <RefusalReasonLine reason={entry.reason} testId={`${testId}-reason`} />
          ) : (
            <LabelText label={cause} />
          )}
        </p>
        {acts.map((act) => (
          <ActionMenu key={act.testId} items={[act]} />
        ))}
      </div>
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-remedy`}>
        {t(`diagnosis.remedy.${entry.remedy_kind}`)}
      </p>
      {entry.fixer && !diagnosis.is_current ? sentence("diagnosis.draftOnly") : null}
      {note ? sentence(REPAIR_NOTE_KEYS[note]) : null}
    </li>
  );
}

function DiagnosisActions({
  diagnosis,
  environment,
  rejectedRepairs,
  onOpenApproval,
}: {
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  rejectedRepairs: readonly string[];
  onOpenApproval?: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const workflowId = diagnosis.workflow_id;
  const [prepared, setPrepared] = useState<TranslationKey | null>(null);
  const prepare = useMutation({
    mutationFn: () =>
      apiRequest<PrepareResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(diagnosis.workflow_version_id ?? "")}/prepare-authority`,
        { method: "POST", body: JSON.stringify({ environment }) },
      ),
    onSuccess: (result) => {
      setPrepared(preparedKey(result));
      void invalidateWorkflowAutomation(client, workflowId);
    },
    onError: () => setPrepared("diagnosis.prepareFailed"),
  });
  const acts = diagnosisActs(
    diagnosis,
    {
      write: session.permissions.includes("workflow:write"),
      run: session.permissions.includes("workflow:run"),
      chat: session.permissions.includes("conversation:write"),
    },
    rejectedRepairs,
  );
  if (!acts.review && !acts.prepare && acts.author.length === 0) return null;
  const [firstStep] = acts.author;
  const chatPrompt =
    acts.author.length === 1 && firstStep
      ? t("diagnosis.chatPrompt", { step: firstStep })
      : t("diagnosis.chatPromptSteps", { steps: acts.author.join(", ") });
  const items: ActionMenuItem[] = [
    ...(acts.review
      ? [
          {
            label: t("remedy.reviewRepair"),
            onSelect: () => void navigate(routerTarget(repairReviewHref(workflowId))),
            testId: "workflow-diagnosis-review",
          },
        ]
      : []),
    ...(acts.prepare
      ? [
          {
            label: t("diagnosis.prepare"),
            disabled: prepare.isPending,
            onSelect: () => prepare.mutate(),
            testId: "workflow-diagnosis-prepare",
          },
        ]
      : []),
    ...(acts.author.length > 0
      ? [
          {
            label: t("remedy.chat"),
            href: absolute(
              chatNewHref({ workflowId, executionId: acts.authorRunId, prompt: chatPrompt }),
            ),
            testId: "workflow-diagnosis-chat",
          },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="workflow-diagnosis-actions">
      <div className="flex flex-wrap items-center gap-2">
        {items.map((item) => (
          <ActionMenu key={item.testId} items={[item]} />
        ))}
      </div>
      {prepared ? (
        <div className="flex flex-col items-start gap-1" role="status">
          <p className="text-sm text-muted-foreground" data-testid="workflow-diagnosis-prepared">
            {t(prepared)}
          </p>
          {prepared === "diagnosis.prepareNeedsSample" && onOpenApproval ? (
            <ActionMenu
              items={[
                {
                  label: t("diagnosis.openApproval"),
                  onSelect: onOpenApproval,
                  testId: "workflow-diagnosis-open-approval",
                },
              ]}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
