import { Notification } from "electron";
import type { NativeNotification } from "../shared/attention.ts";

const live = new Set<Notification>();

export function showNotification(
  content: NativeNotification,
  onClick: (href: string | null) => void,
): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: content.title,
    body: content.body,
    silent: content.silent,
    urgency: content.urgency,
  });
  const release = () => live.delete(notification);
  notification.on("click", () => {
    release();
    onClick(content.href);
  });
  notification.on("close", release);
  notification.on("failed", release);
  live.add(notification);
  notification.show();
}
