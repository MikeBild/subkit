import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import type { ToolPart } from "@/components/ai-elements/tool";
import { GrantWorkflowAuthority } from "@/components/cockpit/grant-workflow-authority";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";
import { chatAutomationSummary, chatAutomationTool } from "@/pages/chat-automation-tool";

/**
 * A `review_workflow_automation` result as the card a person acts on — the
 * same card in the chat and in the side panel. Null when the result is not a
 * card, so the caller renders what it would otherwise.
 */
export function AutomationToolCard({
  tool,
  onAdjust,
}: {
  tool: ToolPart;
  onAdjust?: (workflowId: string) => void;
}) {
  const { t } = useI18n();
  const automation = chatAutomationTool(tool);
  if (!automation || automation.environments.length === 0) return null;
  const summary = chatAutomationSummary(tool);
  return (
    <div
      className="rounded-xl border border-accent/30 bg-accent/10 p-4"
      data-testid="chat-automation-tool"
    >
      <p className="mb-2 font-medium">{t(`chat.automationCard.${summary}.title`)}</p>
      <p className="mb-3 text-sm text-muted-foreground">
        {t(`chat.automationCard.${summary}.hint`)}
      </p>
      {summary !== "authorized" &&
        automation.environments.map((environment) => (
          <AutomationGrant
            key={environment}
            workflowId={automation.workflowId}
            environment={environment}
            testId="chat-automation-tool-review"
            onAdjust={onAdjust ? () => onAdjust(automation.workflowId) : undefined}
          />
        ))}
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
  onPrepareSingleRun,
  onAdjust,
}: {
  workflowId: string;
  environment: "dev" | "prod";
  testId: string;
  /** What the opening button says where it is mounted; the chat's wording otherwise. */
  triggerLabel?: string;
  onPrepareSingleRun?: () => void;
  onAdjust?: () => void;
}) {
  const { t } = useI18n();
  const workflow = useQuery({
    queryKey: ["chat-automation-workflow", workflowId],
    queryFn: async () => {
      const current = await apiRequest<{
        current_version_id: string | null;
        draft_version_id: string | null;
        current_version: number | null;
        steps?: unknown[];
        trigger?: unknown;
      }>(`/v1/workflows/${encodeURIComponent(workflowId)}`);
      const draft = current.draft_version_id
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
      activation={draft ? { expected_current_version_id: current.current_version_id } : undefined}
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
      triggerVariant="default"
    />
  );
}
