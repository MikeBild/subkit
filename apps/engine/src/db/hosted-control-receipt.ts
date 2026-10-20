import { createHash } from "node:crypto";

export function hostedControlReceiptId(
  tenantId: string,
  resourceType:
    | "execution"
    | "mcp_task"
    | "hosted_storage_object"
    | "session"
    | "cockpit_installation",
  resourceId: string,
): string {
  const digest = createHash("sha256")
    .update(`hosted-resource-control:${tenantId}:${resourceType}:${resourceId}`)
    .digest("hex")
    .slice(0, 32);
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const HOSTED_CONTENT_QUOTA_MESSAGE = "Workspace resource allowance exhausted.";
export const HOSTED_CONTENT_QUOTA_CODES = [
  "hosted_storage_quota_exhausted",
  "hosted_resource_count_exhausted",
] as const;
export type HostedContentQuotaCode = (typeof HOSTED_CONTENT_QUOTA_CODES)[number];
