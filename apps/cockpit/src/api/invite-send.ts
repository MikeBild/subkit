import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

export type InviteDelivery = components["schemas"]["InviteDelivery"];

export function sendInvite(userId: string): Promise<InviteDelivery> {
  return apiCall("post", "/v1/identity/users/{id}/invites/send", {
    path: { id: userId },
    body: {},
  });
}
