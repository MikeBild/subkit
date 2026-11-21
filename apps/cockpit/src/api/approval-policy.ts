import type { components } from "@cli-core/engine-api/openapi";
import { useQuery } from "@tanstack/react-query";
import { apiCall } from "./call";

export type ApprovalPolicy = components["schemas"]["ApprovalPolicy"];
export type WorkflowApprovals = ApprovalPolicy["workflow_approvals"];

export const APPROVAL_POLICY_KEY = ["workspace-approval-policy"] as const;

export function readApprovalPolicy(): Promise<ApprovalPolicy> {
  return apiCall("get", "/v1/workspace/approval-policy", {});
}

export function writeApprovalPolicy(
  workflow_approvals: WorkflowApprovals,
): Promise<ApprovalPolicy> {
  return apiCall("put", "/v1/workspace/approval-policy", { body: { workflow_approvals } });
}

export function useApprovalPolicy(enabled = true) {
  return useQuery({
    queryKey: APPROVAL_POLICY_KEY,
    queryFn: readApprovalPolicy,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
