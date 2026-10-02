import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Bot, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, attentionHref, chatNewHref, runHref, workflowAutomationHref } from "@/app/links";
import { useSession } from "@/app/session";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { diagnosisCauseKey, diagnosisNote, type RepairStatus } from "@/lib/gate-diagnosis";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { catalogLabel, LabelText } from "@/lib/machine-label";

export type WorkflowDiagnosis = components["schemas"]["WorkflowDiagnosis"];
type GateDiagnosis = components["schemas"]["GateDiagnosis"];
type RepairResponse = components["schemas"]["ProposeWorkflowRepairResponse"];
type PrepareResponse = { prepared: boolean; reason?: string };
type RepairNote = RepairStatus | "failed";

/** The diagnosis read, under the key every reader of it shares. */
export function workflowDiagnosisQuery(workflowId: string, environment: "dev" | "prod" | null) {
  return {
    queryKey: ["workflow-diagnosis", workflowId, environment],
    queryFn: () =>
      apiRequest<WorkflowDiagnosis>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/diagnosis?environment=${environment}`,
      ),
    retry: false,
  } as const;
}

const REPAIR_NOTE_KEYS: Record<RepairNote, TranslationKey> = {
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

/**
 * The acts that remove one block: filing the engine's deterministic repair,
 * running the trial that supplies missing evidence, or handing it to an
 * author. One implementation for the block's own buttons and for the action
 * beside the page title, so the same press does the same thing in both places.
 */
function useGateRemedy({
  entry,
  diagnosis,
  environment,
  onNote,
  onPrepared,
}: {
  entry: GateDiagnosis;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  /** A repair request that opened nothing new to review. */
  onNote: (note: RepairNote) => void;
  onPrepared: (key: TranslationKey) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const workflowId = diagnosis.workflow_id;
  const review = attentionHref({ review: `workflow:${workflowId}` });
  const refresh = () => client.invalidateQueries({ queryKey: ["workflow-diagnosis", workflowId] });

  const repair = useMutation({
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
        void navigate({ to: review });
        return;
      }
      onNote(diagnosisNote(result.status));
      void refresh();
    },
    onError: () => onNote("failed"),
  });

  const prepare = useMutation({
    mutationFn: () =>
      apiRequest<PrepareResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(diagnosis.workflow_version_id ?? "")}/prepare-authority`,
        { method: "POST", body: JSON.stringify({ environment }) },
      ),
    onSuccess: (result) => {
      onPrepared(preparedKey(result));
      void client.invalidateQueries({ queryKey: ["workflow-authorities", workflowId] });
      void client.invalidateQueries({ queryKey: ["workflow-automation-status", workflowId] });
      void refresh();
    },
    onError: () => onPrepared("diagnosis.prepareFailed"),
  });

  return {
    repair,
    prepare,
    reviewHref: review,
    chatHref: chatNewHref({
      workflowId,
      executionId: entry.evidence.execution_id ?? null,
      prompt: t("diagnosis.chatPrompt", { step: entry.subject.step_id }),
    }),
  };
}

/**
 * Why the approval gate holds this workflow, step by step — and the act that
 * removes each block, where the cockpit can perform it.
 *
 * The same diagnosis HTTP and MCP answer with (`GET …/diagnosis`). A fixable
 * one offers "Automatisch reparieren": that files the engine's deterministic
 * repair as a patch candidate and opens it in the review sheet, where a person
 * previews and approves it — nothing is applied from here. A block that needs
 * a trial run offers it; one that needs an author points to the chat.
 */
export function WorkflowGateDiagnosis({
  workflowId,
  environment,
  onOpenApproval,
}: {
  workflowId: string;
  /** The environment the approval is judged in — the same choice the approval dialog makes. */
  environment: "dev" | "prod" | null;
  /** Opens the approval dialog, where a sample for the trial run is given. */
  onOpenApproval?: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const canRead = session.permissions.includes("workflow:read");
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: canRead && environment !== null,
  });
  if (!canRead || environment === null) return null;
  if (diagnosis.error)
    return (
      <Alert variant="destructive" data-testid="workflow-diagnosis-failed">
        <AlertTitle>{t("diagnosis.loadFailed")}</AlertTitle>
        <AlertDescription>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void diagnosis.refetch()}
            data-testid="workflow-diagnosis-retry"
          >
            {t("session.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  const entries = diagnosis.data?.diagnoses ?? [];
  if (!diagnosis.data || entries.length === 0) return null;
  const answer = diagnosis.data;
  return (
    <section className="grid gap-2" data-testid="workflow-diagnosis">
      <h3 className="text-sm font-semibold">{t("diagnosis.title")}</h3>
      <ul className="grid gap-2">
        {entries.map((entry, index) => (
          <DiagnosisItem
            key={`${entry.subject.step_id}:${entry.code}:${entry.fixer ?? ""}`}
            index={index}
            entry={entry}
            diagnosis={answer}
            environment={environment}
            onOpenApproval={onOpenApproval}
          />
        ))}
      </ul>
    </section>
  );
}

function DiagnosisItem({
  entry,
  diagnosis,
  environment,
  index,
  onOpenApproval,
}: {
  entry: GateDiagnosis;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  index: number;
  onOpenApproval?: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const testId = `workflow-diagnosis-${index}`;
  const [note, setNote] = useState<RepairNote | null>(null);
  const [prepared, setPrepared] = useState<TranslationKey | null>(null);
  const { repair, prepare, reviewHref, chatHref } = useGateRemedy({
    entry,
    diagnosis,
    environment,
    onNote: setNote,
    onPrepared: setPrepared,
  });

  const causeKey = diagnosisCauseKey(entry.code);
  const cause = catalogLabel(entry.code, causeKey, t);
  const canWrite = session.permissions.includes("workflow:write");
  const canRun = session.permissions.includes("workflow:run");
  const canChat = session.permissions.includes("conversation:write");
  const fixable = Boolean(entry.fixer);
  const sentence = (key: TranslationKey) => (
    <p className="text-sm text-muted-foreground" data-testid={`${testId}-note`}>
      {t(key)}
    </p>
  );

  return (
    <li
      className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
      data-testid={testId}
      data-code={entry.code}
      data-remedy={entry.remedy_kind}
    >
      <p className="text-sm font-medium">{t("diagnosis.step", { step: entry.subject.step_id })}</p>
      <p className="text-sm" data-testid={`${testId}-cause`}>
        {/* The precise rule first — the code only says that the approval
            refuses; the reason says why, and decides the repair. */}
        {entry.reason ? (
          <RefusalReasonLine reason={entry.reason} testId={`${testId}-reason`} />
        ) : (
          <LabelText label={cause} />
        )}
      </p>
      {entry.reason && causeKey ? (
        <p className="text-xs text-muted-foreground">{t(causeKey)}</p>
      ) : null}
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-remedy`}>
        {t(`diagnosis.remedy.${entry.remedy_kind}`)}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {fixable && entry.fixer && diagnosis.is_current && canWrite ? (
          entry.candidate_id ? (
            <Button asChild size="sm" variant="outline">
              <a href={absolute(reviewHref)} data-testid={`${testId}-review`}>
                {t("remedy.reviewRepair")}
                <ArrowRight data-icon="inline-end" />
              </a>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={repair.isPending}
              onClick={() => entry.fixer && repair.mutate(entry.fixer)}
              data-testid={`${testId}-repair`}
            >
              <Wrench data-icon="inline-start" />
              {t("diagnosis.repair")}
            </Button>
          )
        ) : null}
        {entry.remedy_kind === "prepare" && canRun && diagnosis.workflow_version_id ? (
          <Button
            size="sm"
            variant="outline"
            disabled={prepare.isPending}
            onClick={() => prepare.mutate()}
            data-testid={`${testId}-prepare`}
          >
            {t("diagnosis.prepare")}
          </Button>
        ) : null}
        {!fixable && entry.remedy_kind !== "prepare" && canChat ? (
          <a
            href={absolute(chatHref)}
            className="text-sm underline underline-offset-4"
            data-testid={`${testId}-chat`}
          >
            {t("remedy.chat")}
          </a>
        ) : null}
        {entry.evidence.execution_id ? (
          <a
            href={absolute(runHref(entry.evidence.execution_id))}
            className="text-sm underline underline-offset-4"
            data-testid={`${testId}-run`}
          >
            {t("remedy.openRun")}
          </a>
        ) : null}
      </div>
      {fixable && !diagnosis.is_current ? sentence("diagnosis.draftOnly") : null}
      {note ? (
        <div className="grid gap-1">
          {sentence(REPAIR_NOTE_KEYS[note])}
          {note === "rejected" && canChat ? (
            <a
              href={absolute(chatHref)}
              className="text-sm underline underline-offset-4"
              data-testid={`${testId}-chat`}
            >
              {t("remedy.chat")}
            </a>
          ) : null}
        </div>
      ) : null}
      {prepared ? (
        <div className="grid gap-1" role="status">
          {sentence(prepared)}
          {prepared === "diagnosis.prepareNeedsSample" ? (
            onOpenApproval ? (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={onOpenApproval}
                data-testid={`${testId}-open-approval`}
              >
                {t("diagnosis.openApproval")}
              </Button>
            ) : (
              <a
                href={absolute(workflowAutomationHref(diagnosis.workflow_id))}
                className="text-sm underline underline-offset-4"
                data-testid={`${testId}-open-approval`}
              >
                {t("diagnosis.openApproval")}
              </a>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The first block's act, beside the page title: the same press as the block's
 * own button below it. What a repair request answers is said as a toast — a
 * title has no room for a sentence.
 */
export function DiagnosisTitleAction({
  diagnosis,
  environment,
  via,
}: {
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  via: "review" | "auto" | "prepare" | "chat";
}) {
  const { t } = useI18n();
  const session = useSession();
  const entry = diagnosis.diagnoses[0];
  if (!entry) return null;
  return (
    <DiagnosisTitleButton
      entry={entry}
      diagnosis={diagnosis}
      environment={environment}
      via={via}
      permissions={session.permissions}
      t={t}
    />
  );
}

function DiagnosisTitleButton({
  entry,
  diagnosis,
  environment,
  via,
  permissions,
  t,
}: {
  entry: GateDiagnosis;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  via: "review" | "auto" | "prepare" | "chat";
  permissions: readonly string[];
  t: ReturnType<typeof useI18n>["t"];
}) {
  const { repair, prepare, reviewHref, chatHref } = useGateRemedy({
    entry,
    diagnosis,
    environment,
    onNote: (note) => toast(t(REPAIR_NOTE_KEYS[note])),
    onPrepared: (key) => toast(t(key)),
  });
  if (via === "review" && permissions.includes("workflow:write"))
    return (
      <Button asChild variant="outline">
        <a href={absolute(reviewHref)} data-testid="detail-action">
          {t("remedy.reviewRepair")}
          <ArrowRight data-icon="inline-end" />
        </a>
      </Button>
    );
  if (via === "auto" && entry.fixer && permissions.includes("workflow:write"))
    return (
      <Button
        variant="outline"
        disabled={repair.isPending}
        onClick={() => entry.fixer && repair.mutate(entry.fixer)}
        data-testid="detail-action"
      >
        <Wrench data-icon="inline-start" />
        {t("diagnosis.repair")}
      </Button>
    );
  if (via === "prepare" && permissions.includes("workflow:run") && diagnosis.workflow_version_id)
    return (
      <Button
        variant="outline"
        disabled={prepare.isPending}
        onClick={() => prepare.mutate()}
        data-testid="detail-action"
      >
        {t("diagnosis.prepare")}
      </Button>
    );
  if (via === "chat" && permissions.includes("conversation:write"))
    return (
      <Button asChild variant="outline">
        <a href={absolute(chatHref)} data-testid="detail-action">
          <Bot data-icon="inline-start" />
          {t("remedy.chat")}
        </a>
      </Button>
    );
  return null;
}
