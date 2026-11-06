import type { paths } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

type MembershipList =
  paths["/v1/identity/memberships"]["get"]["responses"][200]["content"]["application/json"];
export type Membership = MembershipList["items"][number];

export function listMemberships(): Promise<MembershipList> {
  return apiCall("get", "/v1/identity/memberships", {});
}

export function switchMembership(tenantId: string) {
  return apiCall("post", "/v1/identity/tenant-session", { body: { tenant_id: tenantId } });
}
