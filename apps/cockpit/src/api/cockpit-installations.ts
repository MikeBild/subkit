import { ApiError, apiRequest } from "./client";

export interface CockpitInstallation {
  id: string;
  start_url: string;
  manifest_url: string;
  created: boolean;
}

export function getCurrentCockpitInstallation(): Promise<{
  installation: Omit<CockpitInstallation, "created"> | null;
}> {
  return apiRequest("/v1/cockpit/installations");
}

export function createCockpitInstallation(): Promise<CockpitInstallation> {
  return apiRequest("/v1/cockpit/installations", { method: "POST", body: "{}" });
}

export function revokeCockpitInstallation(id: string): Promise<void> {
  return apiRequest(`/v1/cockpit/installations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function pushSubscriptionStatus(
  device?: string | null,
): Promise<{ subscribed: boolean; handled_by_app: boolean }> {
  return apiRequest(
    device
      ? `/v1/cockpit/push-subscription?device=${encodeURIComponent(device)}`
      : "/v1/cockpit/push-subscription",
  );
}

export function preparePushSubscription(): Promise<{ public_key: string }> {
  return apiRequest("/v1/cockpit/push-subscription/prepare", { method: "POST", body: "{}" });
}

export function savePushSubscription(
  subscription: PushSubscription,
  options: { rebind?: boolean; device?: string | null } = {},
): Promise<void> {
  const value = subscription.toJSON();
  return apiRequest("/v1/cockpit/push-subscription", {
    method: "PUT",
    body: JSON.stringify({
      endpoint: value.endpoint,
      keys: value.keys,
      ...(options.rebind ? { rebind: true } : {}),
      ...(options.device ? { device: options.device } : {}),
    }),
  });
}

export async function rebindPushSubscriptionBinding(
  subscription: PushSubscription,
  device: string | null,
): Promise<boolean> {
  try {
    await savePushSubscription(subscription, { rebind: true, device });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return false;
    throw error;
  }
}

export function deletePushSubscription(): Promise<void> {
  return apiRequest("/v1/cockpit/push-subscription", { method: "DELETE" });
}
