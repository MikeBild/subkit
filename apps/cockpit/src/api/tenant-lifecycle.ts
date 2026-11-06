import type { paths } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";
import { apiRequest } from "./client";

type OwnedTenant =
  paths["/v1/identity/owned-tenant"]["get"]["responses"][200]["content"]["application/json"];
type RecoveryState =
  paths["/v1/identity/recovery"]["get"]["responses"][200]["content"]["application/json"];

export function readOwnedTenant(): Promise<OwnedTenant> {
  return apiCall("get", "/v1/identity/owned-tenant", {});
}

export async function requestTenantDeletion(confirmation: string): Promise<void> {
  await apiCall("post", "/v1/identity/owned-tenant/deletion", { body: { confirmation } });
}

export function readRecovery(): Promise<RecoveryState> {
  return apiCall("get", "/v1/identity/recovery", {});
}

export async function restoreTenant(csrfToken: string): Promise<void> {
  await apiRequest("/v1/identity/owned-tenant/restore", {
    method: "POST",
    headers: { "x-subkit-recovery-csrf": csrfToken },
  });
}
