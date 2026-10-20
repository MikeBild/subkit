import { apiRequest } from "./client";

export interface CockpitInstallation {
  id: string;
  start_url: string;
  manifest_url: string;
  created: boolean;
}

export function createCockpitInstallation(): Promise<CockpitInstallation> {
  return apiRequest("/v1/cockpit/installations", { method: "POST", body: "{}" });
}

export function revokeCockpitInstallation(id: string): Promise<void> {
  return apiRequest(`/v1/cockpit/installations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function pushSubscriptionStatus(): Promise<{ subscribed: boolean }> {
  return apiRequest("/v1/cockpit/push-subscription");
}

export function preparePushSubscription(): Promise<{ public_key: string }> {
  return apiRequest("/v1/cockpit/push-subscription/prepare", { method: "POST", body: "{}" });
}

export function savePushSubscription(subscription: PushSubscription): Promise<void> {
  const value = subscription.toJSON();
  return apiRequest("/v1/cockpit/push-subscription", {
    method: "PUT",
    body: JSON.stringify({ endpoint: value.endpoint, keys: value.keys }),
  });
}

export function deletePushSubscription(): Promise<void> {
  return apiRequest("/v1/cockpit/push-subscription", { method: "DELETE" });
}
