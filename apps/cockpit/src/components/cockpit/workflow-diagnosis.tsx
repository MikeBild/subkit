import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, attentionHref, chatNewHref, routerTarget } from "@/app/links";
import { useSession } from "@/app/session";
import { ActionMenu, ContextHelp, DataState } from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { tableColumns } from "@/components/cockpit/table-columns";
import { AUTOMATION_REFRESH_MS, invalidateWorkflowAutomation } from "@/lib/automation-queries";
import {
  type DiagnosisFix,
  diagnosisCauseKey,
  diagnosisFix,
  diagnosisNote,
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
  const { t, dateTime } = useI18n();
  const session = useSession();
  const canRead = session.permissions.includes("workflow:read");
  const [notes, setNotes] = useState<Readonly<Record<string, RepairNote>>>({});
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: canRead && environment !== null,
    retryOnMount: false,
  });
  const prepare = usePrepare(diagnosis.data ?? null, environment);
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
  const rights = {
    write: session.permissions.includes("workflow:write"),
    run: session.permissions.includes("workflow:run"),
    chat: session.permissions.includes("conversation:write"),
  };
  const column = tableColumns<GateDiagnosis>({ t, dateTime });
  const columns = [
    column.custom(
      "step",
      (entry) => entry.subject.step_id,
      t("diagnosis.column.step"),
      (entry) => <span className="font-mono text-sm">{entry.subject.step_id}</span>,
      { width: "w-[30%]" },
    ),
    column.custom(
      "reason",
      (entry) => entry.code,
      t("diagnosis.column.reason"),
      (entry) => {
        const index = entries.indexOf(entry);
        const note = notes[entry.subject.step_id];
        return (
          <DiagnosisReason
            entry={entry}
            index={index}
            note={
              note
                ? REPAIR_NOTE_KEYS[note]
                : entry.fixer && !answer.is_current
                  ? "diagnosis.draftOnly"
                  : null
            }
          />
        );
      },
      { width: "w-[70%]" },
    ),
  ];
  return (
    <div data-testid="workflow-diagnosis" className="flex flex-col gap-2">
      <RecordTable
        collectionId="workflow-diagnosis-table"
        columns={columns}
        data={[...entries]}
        emptyLine={t("diagnosis.title")}
        getRowId={(entry) => `${entry.subject.step_id}:${entry.code}:${entry.fixer ?? ""}`}
        rowActions={(entry, index) => (
          <DiagnosisFixAction
            entry={entry}
            index={index}
            diagnosis={answer}
            environment={environment}
            fix={diagnosisFix(entry, answer, rights, rejectedRepairs)}
            prepare={prepare}
            onNote={(note) => {
              setNotes((current) => ({ ...current, [entry.subject.step_id]: note }));
              if (note === "rejected") onRepairRejected(entry.subject.step_id);
            }}
          />
        )}
      />
      {prepare.result ? (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <p className="text-sm text-muted-foreground" data-testid="workflow-diagnosis-prepared">
            {t(prepare.result)}
          </p>
          {prepare.result === "diagnosis.prepareNeedsSample" && onOpenApproval ? (
            <ActionMenu
              size="sm"
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

function DiagnosisReason({
  entry,
  index,
  note,
}: {
  entry: GateDiagnosis;
  index: number;
  note: TranslationKey | null;
}) {
  const { t } = useI18n();
  const testId = `workflow-diagnosis-${index}`;
  const cause = catalogLabel(entry.code, diagnosisCauseKey(entry.code), t);
  return (
    <span
      className="flex min-w-0 flex-col gap-0.5"
      data-testid={testId}
      data-code={entry.code}
      data-remedy={entry.remedy_kind}
    >
      <span className="flex min-w-0 items-center gap-1 text-sm">
        <span className="min-w-0" data-testid={`${testId}-cause`}>
          {entry.reason ? (
            <RefusalReasonLine reason={entry.reason} testId={`${testId}-reason`} />
          ) : (
            <LabelText label={cause} />
          )}
        </span>
        <ContextHelp label={t("diagnosis.title")} testId={`${testId}-help`}>
          {t(`diagnosis.remedy.${entry.remedy_kind}`)}
        </ContextHelp>
      </span>
      {note ? (
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-note`}>
          {t(note)}
        </span>
      ) : null}
    </span>
  );
}

interface Prepare {
  pending: boolean;
  result: TranslationKey | null;
  run(): void;
}

function usePrepare(
  diagnosis: WorkflowDiagnosis | null,
  environment: "dev" | "prod" | null,
): Prepare {
  const client = useQueryClient();
  const [result, setResult] = useState<TranslationKey | null>(null);
  const workflowId = diagnosis?.workflow_id ?? "";
  const prepare = useMutation({
    mutationFn: () =>
      apiRequest<PrepareResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(diagnosis?.workflow_version_id ?? "")}/prepare-authority`,
        { method: "POST", body: JSON.stringify({ environment }) },
      ),
    onSuccess: (response) => {
      setResult(preparedKey(response));
      void invalidateWorkflowAutomation(client, workflowId);
    },
    onError: () => setResult("diagnosis.prepareFailed"),
  });
  return { pending: prepare.isPending, result, run: () => prepare.mutate() };
}

function DiagnosisFixAction({
  entry,
  index,
  diagnosis,
  environment,
  fix,
  prepare,
  onNote,
}: {
  entry: GateDiagnosis;
  index: number;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  fix: DiagnosisFix | null;
  prepare: Prepare;
  onNote: (note: RepairNote) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const repair = useStepRepair({ entry, diagnosis, environment, onNote });
  const testId = `workflow-diagnosis-${index}`;
  if (fix === "auto")
    return (
      <ActionMenu
        size="sm"
        items={[
          {
            label: t("diagnosis.repair"),
            disabled: repair.isPending,
            onSelect: () => entry.fixer && repair.mutate(entry.fixer),
            testId: `${testId}-repair`,
          },
        ]}
      />
    );
  if (fix === "review")
    return (
      <ActionMenu
        size="sm"
        items={[
          {
            label: t("remedy.reviewRepair"),
            onSelect: () => void navigate(routerTarget(repairReviewHref(diagnosis.workflow_id))),
            testId: `${testId}-review`,
          },
        ]}
      />
    );
  if (fix === "prepare")
    return (
      <ActionMenu
        size="sm"
        items={[
          {
            label: t("diagnosis.prepare"),
            disabled: prepare.pending,
            onSelect: prepare.run,
            testId: `${testId}-prepare`,
          },
        ]}
      />
    );
  if (fix === "chat")
    return (
      <ActionMenu
        size="sm"
        items={[
          {
            label: t("remedy.chat"),
            href: absolute(
              chatNewHref({
                workflowId: diagnosis.workflow_id,
                executionId: entry.evidence.execution_id ?? null,
                prompt: t("diagnosis.chatPrompt", { step: entry.subject.step_id }),
                references: [
                  { type: "workflow", id: diagnosis.workflow_id },
                  ...(entry.evidence.execution_id
                    ? [{ type: "execution" as const, id: entry.evidence.execution_id }]
                    : []),
                ],
              }),
            ),
            testId: `${testId}-chat`,
          },
        ]}
      />
    );
  return null;
}
