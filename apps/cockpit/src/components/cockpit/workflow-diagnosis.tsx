import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Wrench } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, attentionHref, chatNewHref, runHref } from "@/app/links";
import { useSession } from "@/app/session";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { diagnosisCauseKey, diagnosisNote, type RepairStatus } from "@/lib/gate-diagnosis";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { catalogLabel, LabelText } from "@/lib/machine-label";

type WorkflowDiagnosis = components["schemas"]["WorkflowDiagnosis"];
type GateDiagnosis = components["schemas"]["GateDiagnosis"];
type RepairResponse = components["schemas"]["ProposeWorkflowRepairResponse"];
type PrepareResponse = { prepared: boolean; reason?: string };

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
}: {
  workflowId: string;
  /** The environment the approval is judged in — the same choice the approval dialog makes. */
  environment: "dev" | "prod" | null;
}) {
  const { t } = useI18n();
  const session = useSession();
  const canRead = session.permissions.includes("workflow:read");
  const diagnosis = useQuery({
    queryKey: ["workflow-diagnosis", workflowId, environment],
    enabled: canRead && environment !== null,
    queryFn: () =>
      apiRequest<WorkflowDiagnosis>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/diagnosis?environment=${environment}`,
      ),
    retry: false,
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
      <div>
        <h3 className="text-sm font-semibold">{t("diagnosis.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("diagnosis.description")}</p>
      </div>
      <ul className="grid gap-2">
        {entries.map((entry, index) => (
          <DiagnosisItem
            key={`${entry.subject.step_id}:${entry.code}:${entry.fixer ?? ""}`}
            index={index}
            entry={entry}
            diagnosis={answer}
            environment={environment}
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
}: {
  entry: GateDiagnosis;
  diagnosis: WorkflowDiagnosis;
  environment: "dev" | "prod";
  index: number;
}) {
  const { t } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const client = useQueryClient();
  const workflowId = diagnosis.workflow_id;
  const testId = `workflow-diagnosis-${index}`;
  const [note, setNote] = useState<RepairStatus | "failed" | null>(null);
  const [prepared, setPrepared] = useState<TranslationKey | null>(null);
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
      setNote(diagnosisNote(result.status));
      void refresh();
    },
    onError: () => setNote("failed"),
  });

  const prepare = useMutation({
    mutationFn: () =>
      apiRequest<PrepareResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(diagnosis.workflow_version_id ?? "")}/prepare-authority`,
        { method: "POST", body: JSON.stringify({ environment }) },
      ),
    onSuccess: (result) => {
      setPrepared(
        result.prepared
          ? "diagnosis.prepared"
          : result.reason === "preparation_in_flight"
            ? "diagnosis.prepareInFlight"
            : result.reason === "input_required"
              ? "diagnosis.prepareNeedsSample"
              : "diagnosis.prepareNotRun",
      );
      void client.invalidateQueries({ queryKey: ["workflow-authorities", workflowId] });
      void refresh();
    },
    onError: () => setPrepared("diagnosis.prepareFailed"),
  });

  const causeKey = diagnosisCauseKey(entry.code);
  const cause = catalogLabel(entry.code, causeKey, t);
  const canWrite = session.permissions.includes("workflow:write");
  const canRun = session.permissions.includes("workflow:run");
  const canChat = session.permissions.includes("conversation:write");
  const fixable = Boolean(entry.fixer);
  const chatHref = chatNewHref({
    workflowId,
    executionId: entry.evidence.execution_id ?? null,
    prompt: t("diagnosis.chatPrompt", { step: entry.subject.step_id }),
  });
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
            <Button asChild size="sm">
              <a href={absolute(review)} data-testid={`${testId}-review`}>
                {t("remedy.reviewRepair")}
                <ArrowRight data-icon="inline-end" />
              </a>
            </Button>
          ) : (
            <Button
              size="sm"
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
            variant={fixable ? "outline" : "default"}
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
          {sentence(
            note === "failed"
              ? "diagnosis.repairFailed"
              : note === "rejected"
                ? "diagnosis.repairRejected"
                : note === "applied"
                  ? "diagnosis.repairApplied"
                  : "diagnosis.repairStale",
          )}
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
            <a
              href="#workflow-authorities"
              className="text-sm underline underline-offset-4"
              data-testid={`${testId}-open-approval`}
            >
              {t("diagnosis.openApproval")}
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
