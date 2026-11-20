import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

export type ApprovalRule = components["schemas"]["ToolApprovalRule"];

export const APPROVAL_RULES_KEY = ["approval-rules"] as const;

export async function listApprovalRules(): Promise<ApprovalRule[]> {
  return (await apiCall("get", "/v1/approval-rules", {})).items;
}

export function acceptApprovalRule(id: string): Promise<ApprovalRule> {
  return apiCall("post", "/v1/approval-rules/{id}/accept", { path: { id } });
}

export function dismissApprovalRule(id: string): Promise<ApprovalRule> {
  return apiCall("post", "/v1/approval-rules/{id}/dismiss", { path: { id } });
}

export function revokeApprovalRule(id: string): Promise<ApprovalRule> {
  return apiCall("delete", "/v1/approval-rules/{id}", { path: { id } });
}

export function renewApprovalRule(id: string): Promise<ApprovalRule> {
  return apiCall("post", "/v1/approval-rules/{id}/renew", { path: { id } });
}
