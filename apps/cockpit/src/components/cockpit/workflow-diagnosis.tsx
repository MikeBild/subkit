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

/** The diagnosis read, under the key every reader of it shares. */
export function workflowDiagnosisQuery(workflowId: string, environment: "dev" | "prod" | null) {
  return {
    queryKey: ["workflow-diagnosis", workflowId, environment],
    queryFn: () =>
      apiRequest<WorkflowDiagnosis>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/diagnosis?environment=${environment}`,
      ),
    retry: false,
    // Like the approvals and the verified status it is read beside: a block
    // that was removed elsewhere must not stay on the page until a reload.
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

/** The review sheet a workflow's filed repairs wait in. */
export const repairReviewHref = (workflowId: string) =>
  attentionHref({ review: `workflow:${workflowId}` });

/**
 * Filing the engine's deterministic repair for one step. One implementation
 * for the step's own button and for the approval dialog's remedy, so the same
 * press does the same thing in both views.
 */
export function useStepRepair({
  entry,
  diagnosis,
  environment,
  onNote,
}: {
  entry: GateDiagnosis;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  /** A repair request that opened nothing new to review. */
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
      // Only an open proposal has a card in the review sheet. A rejected one
      // keeps holding for this version; sending the reader to an empty sheet
      // would hide that.
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

/**
 * Why the approval gate holds this workflow, step by step — and the acts that
 * remove the blocks, where the cockpit can perform them.
 *
 * The same diagnosis HTTP and MCP answer with (`GET …/diagnosis`). A step the
 * engine can repair offers "Automatisch reparieren": that files the engine's
 * deterministic repair as a patch candidate and opens it in the review sheet,
 * where a person previews and approves it — nothing is applied from here.
 *
 * What does the same thing whichever step asks for it stands once, under the
 * list: reviewing the filed repairs, the trial run, the conversation with an
 * author. A button per step for one act would be the same press several times.
 */
export function WorkflowGateDiagnosis({
  workflowId,
  environment,
  onOpenApproval,
  ownRetry,
  rejectedRepairs,
  onRepairRejected,
}: {
  workflowId: string;
  /** The environment the approval is judged in — the same choice the approval dialog makes. */
  environment: "dev" | "prod" | null;
  /**
   * Opens the approval dialog, where a sample for the trial run is given.
   * Absent where the strip already carries the opener.
   */
  onOpenApproval?: () => void;
  /** False where the strip's own re-check re-reads the diagnosis. */
  ownRetry: boolean;
  /** The steps whose computed repair was refused for this version. */
  rejectedRepairs: readonly string[];
  onRepairRejected: (stepId: string) => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const canRead = session.permissions.includes("workflow:read");
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: canRead && environment !== null,
    // The strip around this block already made the read and repeats it on its
    // own interval. Retrying on mount would put a FAILED read back to
    // "pending", which takes the strip's state away, which unmounts this
    // block, which mounts it again when the read fails — without end.
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
              // One run can refuse several steps: its link stands at the first.
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
  // A repair that is already filed is reviewed under the list, with the others.
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
          {/* The precise rule first — the code only says that the approval
              refuses; the reason says why, and decides the repair. */}
          {entry.reason ? (
            <RefusalReasonLine reason={entry.reason} testId={`${testId}-reason`} />
          ) : (
            <LabelText label={cause} />
          )}
        </p>
        {/* Each act its own button, side by side — never a menu of two. */}
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

/** The acts that stand once for the whole diagnosis (`diagnosisActs`). */
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
          {/* The approval dialog's one opener while the strip offers none. */}
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
