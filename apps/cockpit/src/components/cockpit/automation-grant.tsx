import { useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import type { ToolPart } from "@/components/ai-elements/tool";
import { useWorkflowAutomation } from "@/components/cockpit/automation-panel";
import { GrantOpeningNotice } from "@/components/cockpit/grant-notices";
import { GrantWorkflowAuthority } from "@/components/cockpit/grant-workflow-authority";
import { Button } from "@/components/ui/button";
import {
  type AutomationWorkflow,
  automationActionKey,
  automationCard,
} from "@/lib/automation-state";
import { grantOpeningNotice, hookStartedOnly } from "@/lib/grant-context";
import { useI18n } from "@/lib/i18n-context";
import { chatAutomationTool } from "@/pages/chat-automation-tool";

type AutomationRecord = AutomationWorkflow & { steps?: unknown[]; trigger?: unknown };

/** The workflow a review is about, with its saved change when one waits. */
function useAutomationWorkflow(workflowId: string) {
  return useQuery({
    queryKey: ["chat-automation-workflow", workflowId],
    enabled: workflowId !== "",
    queryFn: async () => {
      const current = await apiRequest<AutomationRecord>(
        `/v1/workflows/${encodeURIComponent(workflowId)}`,
      );
      // A saved change waits only when the draft is another version than the
      // running one (`reviewTarget`). The record names the running version as
      // its draft once a change was applied; reading that as a pending change
      // offered to "apply" the version that already runs.
      const pending =
        typeof current.draft_version_id === "string" &&
        current.draft_version_id !== current.current_version_id;
      const draft = pending
        ? await apiRequest<components["schemas"]["WorkflowDraft"]>(
            `/v1/workflows/${encodeURIComponent(workflowId)}/draft`,
          )
        : null;
      if (
        draft &&
        (draft.version_id !== current.draft_version_id ||
          draft.current_version_id !== current.current_version_id)
      )
        throw new Error("workflow_changed");
      return { current, draft };
    },
    staleTime: 0,
  });
}

/**
 * A `review_workflow_automation` result as the card a person acts on — the
 * same card in the chat and in the side panel. Null when the result is not a
 * card, so the caller renders what it would otherwise.
 *
 * The tool result only says THAT there is something to review. What the card
 * says and offers is read now, from the same decision the workflow's page
 * makes (`lib/automation-state.ts`): a card in a transcript is read long after
 * the tool ran, and it must not offer yesterday's step.
 */
export function AutomationToolCard({
  tool,
  onAdjust,
  onPrepareSingleRun,
}: {
  tool: ToolPart;
  onAdjust?: (workflowId: string) => void;
  /**
   * Hands a single run to the conversation, where the review cannot permit
   * repeated ones. The card is the transcript's one way into the review, so
   * whatever the review can lead to is reachable from it.
   */
  onPrepareSingleRun?: (workflowId: string) => void;
}) {
  const { t } = useI18n();
  const automation = chatAutomationTool(tool);
  const workflowId = automation?.workflowId ?? "";
  const workflow = useAutomationWorkflow(workflowId);
  if (!automation || automation.environments.length === 0) return null;
  return (
    <div
      className="rounded-xl border border-accent/30 bg-accent/10 p-4"
      data-testid="chat-automation-tool"
    >
      {workflow.data ? (
        <AutomationCardBody
          workflowId={workflowId}
          workflow={workflow.data.current}
          onAdjust={onAdjust ? () => onAdjust(workflowId) : undefined}
          onPrepareSingleRun={onPrepareSingleRun ? () => onPrepareSingleRun(workflowId) : undefined}
        />
      ) : workflow.isPending ? (
        <p role="status">{t("chat.activation.loading")}</p>
      ) : (
        <CardUnread onRetry={() => void workflow.refetch()} />
      )}
    </div>
  );
}

/** The state could not be read: say so, and offer to read again. Never a guess. */
function CardUnread({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="status" className="flex flex-col items-start gap-2">
      <p>{t("chat.activation.failed")}</p>
      <Button
        variant="outline"
        size="sm"
        data-testid="chat-automation-tool-retry"
        onClick={onRetry}
      >
        {t("chat.activation.retry")}
      </Button>
    </div>
  );
}

function AutomationCardBody({
  workflowId,
  workflow,
  onAdjust,
  onPrepareSingleRun,
}: {
  workflowId: string;
  workflow: AutomationWorkflow;
  onAdjust?: () => void;
  onPrepareSingleRun?: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const automation = useWorkflowAutomation(workflowId, workflow, session.permissions);
  if (automation.failed) return <CardUnread onRetry={automation.retry} />;
  const { state } = automation;
  if (!state) return <p role="status">{t("chat.activation.loading")}</p>;
  const card = automationCard(state, workflow.webhooks_active);
  const notice =
    card.environments.length > 0
      ? grantOpeningNotice({
          diagnoses: automation.diagnosis?.diagnoses,
          hookStarted: hookStartedOnly(state.triggers, workflow.webhooks_active),
          mayRun: automation.canRun,
        })
      : null;
  const [only, ...further] = card.environments;
  return (
    <div data-state={state.state} data-testid="chat-automation-tool-body">
      <p className="mb-2 font-medium">{t(card.titleKey)}</p>
      <p className="mb-3 text-sm text-muted-foreground">{t(card.hintKey)}</p>
      {notice ? (
        <div className="mb-3">
          <GrantOpeningNotice notice={notice} />
        </div>
      ) : null}
      {/* One decision, one button. Two only when starts in both halves of the
          installation wait at once — then each says which half it is. */}
      {/* Not a decision: the page's own act for the state, or none at all. */}
      {card.act === "resume" && state.primaryAction?.kind === "resume" && automation.canWrite ? (
        <Button
          variant="outline"
          size="sm"
          disabled={automation.resume.pending}
          onClick={() =>
            state.primaryAction?.kind === "resume" &&
            automation.resume.run(state.primaryAction.scheduleIds)
          }
          data-testid="chat-automation-tool-resume"
        >
          <Play data-icon="inline-start" />
          {t(automationActionKey(state.primaryAction))}
        </Button>
      ) : card.act === "recheck" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={automation.refresh}
          data-testid="chat-automation-tool-recheck"
        >
          {t(card.actionKey)}
        </Button>
      ) : card.act !== "review" ? null : only && further.length === 0 ? (
        <AutomationGrant
          workflowId={workflowId}
          environment={only}
          testId="chat-automation-tool-review"
          triggerLabel={t(card.actionKey)}
          onAdjust={onAdjust}
          onPrepareSingleRun={onPrepareSingleRun}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {card.environments.map((environment) =>
            environment === "prod" ? (
              <AutomationGrant
                key={environment}
                workflowId={workflowId}
                environment="prod"
                testId="chat-automation-tool-review-prod"
                triggerLabel={t("chat.automationCard.review.prod")}
                onAdjust={onAdjust}
                onPrepareSingleRun={onPrepareSingleRun}
              />
            ) : (
              <AutomationGrant
                key={environment}
                workflowId={workflowId}
                environment="dev"
                testId="chat-automation-tool-review-dev"
                triggerLabel={t("chat.automationCard.review.dev")}
                triggerVariant="outline"
                onAdjust={onAdjust}
                onPrepareSingleRun={onPrepareSingleRun}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The approval of a workflow's automatic runs, opened where the hold is seen:
 * the chat, the side panel, a held webhook's card.
 *
 * The saved draft is the review target; never silently authorize the older
 * active version.
 */
export function AutomationGrant({
  workflowId,
  environment,
  testId,
  triggerLabel,
  triggerVariant = "default",
  onPrepareSingleRun,
  onAdjust,
}: {
  workflowId: string;
  environment: "dev" | "prod";
  testId: string;
  /** What the opening button says where it is mounted; the chat's wording otherwise. */
  triggerLabel?: string;
  /** Filled where it is the one decision; `outline` for a second one beside it. */
  triggerVariant?: "default" | "outline";
  onPrepareSingleRun?: () => void;
  onAdjust?: () => void;
}) {
  const { t } = useI18n();
  const workflow = useAutomationWorkflow(workflowId);
  if (workflow.isPending) return <p role="status">{t("chat.activation.loading")}</p>;
  const versionId = workflow.data?.draft?.version_id ?? workflow.data?.current.current_version_id;
  if (workflow.error || !workflow.data || !versionId)
    return (
      <div role="status" className="flex flex-col gap-2">
        <p>{t("chat.activation.failed")}</p>
        <Button
          variant="outline"
          size="sm"
          data-testid="chat-activation-retry"
          onClick={() => void workflow.refetch()}
        >
          {t("chat.activation.retry")}
        </Button>
      </div>
    );
  const { current, draft } = workflow.data;
  return (
    <GrantWorkflowAuthority
      key={versionId}
      workflowId={workflowId}
      versionId={versionId}
      activation={
        draft ? { expected_current_version_id: current.current_version_id ?? null } : undefined
      }
      reviewContent={
        draft ? (
          <div className="flex flex-col gap-2" data-testid="chat-activation-change-summary">
            <p>{t("chat.activation.version", { version: String(draft.version) })}</p>
            <p>
              {t("chat.activation.active", {
                version:
                  current.current_version == null
                    ? t("chat.activation.none")
                    : String(current.current_version),
              })}
            </p>
            <p>
              {t("chat.activation.stepsChanged", {
                count: String(
                  draft.definition.steps.filter(
                    (step) =>
                      JSON.stringify(step) !==
                      JSON.stringify(
                        current.steps?.find(
                          (value) =>
                            value &&
                            typeof value === "object" &&
                            "id" in value &&
                            value.id === step.id,
                        ),
                      ),
                  ).length,
                ),
              })}
            </p>
            <p>
              {t(
                JSON.stringify(current.trigger ?? null) ===
                  JSON.stringify(draft.definition.trigger ?? null)
                  ? "chat.activation.scheduleKept"
                  : "chat.activation.scheduleChanged",
              )}
            </p>
          </div>
        ) : undefined
      }
      onSingleRun={onPrepareSingleRun}
      onAdjust={onAdjust}
      initialEnvironment={environment}
      triggerTestId={testId}
      triggerLabel={triggerLabel ?? t("chat.schedule.review")}
      triggerVariant={triggerVariant}
    />
  );
}
