import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApprovalPolicy } from "@/api/approval-policy";
import { apiCall } from "@/api/call";
import { type PairAction, type PairVisibility, pairVisibility } from "./pair-model";

export const pairKeys = {
  list: (workflowId: string) => ["pair-approvals", workflowId] as const,
};

export function usePairVisibility(enabled: boolean, chosen = false): PairVisibility {
  const policy = useApprovalPolicy(enabled);
  return pairVisibility(policy.isError ? null : policy.data, chosen);
}

export function usePairApprovals(workflowId: string, enabled: boolean) {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: pairKeys.list(workflowId),
    enabled,
    retry: false,
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/pair-approvals", { path: { id: workflowId } }),
  });
  const act = useMutation({
    mutationFn: ({
      requestId,
      action,
    }: {
      requestId: string;
      action: PairAction;
    }): Promise<unknown> => {
      const path = { id: workflowId, request_id: requestId };
      if (action === "approve")
        return apiCall("post", "/v1/workflows/{id}/pair-approvals/{request_id}/approve", { path });
      if (action === "decline")
        return apiCall("post", "/v1/workflows/{id}/pair-approvals/{request_id}/decline", { path });
      return apiCall("post", "/v1/workflows/{id}/pair-approvals/{request_id}/withdraw", { path });
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: pairKeys.list(workflowId) });
      await client.invalidateQueries({ queryKey: ["workflow-authorities", workflowId] });
      await client.invalidateQueries({ queryKey: ["attention"] });
    },
  });
  return {
    items: list.isError ? [] : (list.data?.items ?? []),
    loading: enabled && list.isPending,
    failed: list.isError,
    act: (requestId: string, action: PairAction) => act.mutate({ requestId, action }),
    pending: act.isPending ? (act.variables?.action ?? null) : null,
    error: act.error,
    reset: act.reset,
  };
}
