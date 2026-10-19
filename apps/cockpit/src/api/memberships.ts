import { apiRequest } from "./client";
import type { paths } from "./schema";

type MembershipList =
  paths["/v1/identity/memberships"]["get"]["responses"][200]["content"]["application/json"];
export type Membership = MembershipList["items"][number];

export function listMemberships(): Promise<MembershipList> {
  return apiRequest("/v1/identity/memberships");
}

export function switchMembership(tenantId: string): Promise<unknown> {
  return apiRequest("/v1/identity/tenant-session", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId }),
  });
}
