import type { components } from "@cli-core/engine-api/openapi";
import { useQuery } from "@tanstack/react-query";
import { apiCall } from "./call";

export type NotificationPause = components["schemas"]["NotificationPause"];
export type PauseRequest = components["schemas"]["PauseNotificationsBody"];

export const NOTIFICATION_PAUSE_KEY = ["notification-pause"] as const;

export function readNotificationPause(): Promise<NotificationPause> {
  return apiCall("get", "/v1/identity/me/notification-pause", {});
}

export function pauseNotifications(body: PauseRequest): Promise<NotificationPause> {
  return apiCall("put", "/v1/identity/me/notification-pause", { body });
}

export function resumeNotifications(): Promise<NotificationPause> {
  return apiCall("delete", "/v1/identity/me/notification-pause", {});
}

export function useNotificationPause(enabled = true) {
  return useQuery({
    queryKey: NOTIFICATION_PAUSE_KEY,
    queryFn: readNotificationPause,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}
