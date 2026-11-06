import type { paths } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";
import { ApiError } from "./client";

export type CockpitInstallation =
  paths["/v1/cockpit/installations"]["post"]["responses"][200]["content"]["application/json"];
type CurrentCockpitInstallation =
  paths["/v1/cockpit/installations"]["get"]["responses"][200]["content"]["application/json"];

export function getCurrentCockpitInstallation(): Promise<CurrentCockpitInstallation> {
  return apiCall("get", "/v1/cockpit/installations", {});
}

export function createCockpitInstallation(): Promise<CockpitInstallation> {
  return apiCall("post", "/v1/cockpit/installations", { body: {} });
}

export async function revokeCockpitInstallation(id: string): Promise<void> {
  await apiCall("delete", "/v1/cockpit/installations/{installationId}", {
    path: { installationId: id },
  });
}

export function pushSubscriptionStatus(
  device?: string | null,
): Promise<{ subscribed: boolean; handled_by_app: boolean }> {
  return apiCall("get", "/v1/cockpit/push-subscription", {
    query: device ? { device } : {},
  });
}

export function preparePushSubscription(): Promise<{ public_key: string }> {
  return apiCall("post", "/v1/cockpit/push-subscription/prepare", {});
}

export async function savePushSubscription(
  subscription: PushSubscription,
  options: { rebind?: boolean; device?: string | null } = {},
): Promise<void> {
  const value = subscription.toJSON();
  const p256dh = value.keys?.p256dh;
  const auth = value.keys?.auth;
  if (!value.endpoint || !p256dh || !auth) throw new Error("push-subscription-incomplete");
  await apiCall("put", "/v1/cockpit/push-subscription", {
    body: {
      endpoint: value.endpoint,
      keys: { p256dh, auth },
      ...(options.rebind ? { rebind: true } : {}),
      ...(options.device ? { device: options.device } : {}),
    },
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

export async function deletePushSubscription(): Promise<void> {
  await apiCall("delete", "/v1/cockpit/push-subscription", {});
}
