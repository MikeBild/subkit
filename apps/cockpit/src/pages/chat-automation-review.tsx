import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { GrantWorkflowAuthority } from "@/components/cockpit/grant-workflow-authority";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";

/** Reuses the exact-version human review; opening it never grants permission. */
export function ChatAutomationReview({
  workflowId,
  environment,
  testId,
}: {
  workflowId: string;
  environment: "dev" | "prod";
  testId: string;
}) {
  const { t } = useI18n();
  const workflow = useQuery({
    queryKey: ["chat-automation-workflow", workflowId],
    queryFn: () =>
      apiRequest<{ current_version_id: string | null }>(
        `/v1/workflows/${encodeURIComponent(workflowId)}`,
      ),
    staleTime: 0,
  });
  if (!workflow.data?.current_version_id)
    return (
      <Button variant="outline" size="sm" asChild>
        <a
          href={`/cockpit/workflows/${encodeURIComponent(workflowId)}#workflow-authorities`}
          data-testid={testId}
        >
          {t("chat.schedule.review")}
        </a>
      </Button>
    );
  return (
    <GrantWorkflowAuthority
      workflowId={workflowId}
      versionId={workflow.data.current_version_id}
      initialEnvironment={environment}
      triggerTestId={testId}
      triggerLabel={t("chat.schedule.review")}
    />
  );
}
