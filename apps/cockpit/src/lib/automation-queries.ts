import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { carryOverChoice } from "@/lib/automation-state";
import { useI18n } from "@/lib/i18n-context";
import type { WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

export function automationQueryKeys(workflowId: string): QueryKey[] {
  return [
    ["workflow-authorities", workflowId],
    ["workflow-automation-status", workflowId],
    ["workflow-diagnosis", workflowId],
    ["workflow", workflowId, "schedules"],
    ["workflow-invocation", workflowId],
    ["workflow-draft-version", workflowId],
    ["workflow-grant-context", workflowId],
    ["chat-automation-workflow", workflowId],
    ["catalog-detail", "workflows", workflowId],
  ];
}

export async function invalidateWorkflowAutomation(
  client: QueryClient,
  workflowId: string,
): Promise<void> {
  await Promise.all(
    automationQueryKeys(workflowId).map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}

export const AUTOMATION_REFRESH_MS = 30_000;

export function useAuthorityCarryOver({
  workflowId,
  versionId,
  environment,
  activation,
  conversationId,
  enabled = true,
}: {
  workflowId: string;
  versionId: string | null | undefined;
  environment: "dev" | "prod";
  activation?: { expected_current_version_id: string | null };
  conversationId?: string;
  enabled?: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const preview = useQuery({
    queryKey: ["workflow-grant-context", workflowId, "carry-over", versionId, environment],
    enabled: enabled && Boolean(versionId) && activation !== undefined,
    queryFn: () =>
      apiRequest<WorkflowAuthorityPreview>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId ?? "")}/authority-preview?environment=${environment}`,
      ),
    staleTime: 0,
  });
  const choice = carryOverChoice(preview.data, activation !== undefined);
  const adoption = useMutation({
    mutationFn: () => {
      if (!preview.data || !activation || !versionId || choice !== "adopt")
        throw new Error("carry_over_unavailable");
      return apiRequest(`/v1/workflows/${encodeURIComponent(workflowId)}/activate-draft`, {
        method: "POST",
        body: JSON.stringify({
          ...(conversationId ? { conversation_id: conversationId } : {}),
          workflow_version_id: versionId,
          expected_current_version_id: activation.expected_current_version_id,
          expected_manifest_digest: preview.data.digest,
          execution_environment: environment,
        }),
      });
    },
    onSuccess: () => toast.success(t("authority.adopted")),
    onError: () => toast.error(t("authority.adoptFailed")),
    onSettled: async () => {
      await invalidateWorkflowAutomation(client, workflowId);
      await Promise.all(
        [["conversation"], ["attention"], ["workflows"], ["workflow-schedule-holds"]].map(
          (queryKey) => client.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
  return {
    choice: preview.isSuccess ? choice : null,
    adopt: () => adoption.mutate(),
    adopting: adoption.isPending,
  };
}
