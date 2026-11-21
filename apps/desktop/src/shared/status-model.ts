import type { NativeNotification } from "./attention.ts";
import { type Locale, t } from "./i18n.ts";
import { type TooOldAsk, tooOldCopyIn } from "./server-too-old.ts";
import type { Connection } from "./tray-model.ts";
import type { UpdateState } from "./updates.ts";

export type StatusNotice = "offline" | "online" | "expired" | "revoked";

export type ShellTarget = "cockpit" | "connect" | "settings";

export function statusNotice(previous: Connection, next: Connection): StatusNotice | null {
  if (previous === next) return null;
  if (next === "offline") return previous === "online" ? "offline" : null;
  if (next === "online") return previous === "offline" ? "online" : null;
  if (next === "expired" || next === "revoked") return next;
  return null;
}

export interface StatusNotification {
  notification: NativeNotification;
  target: ShellTarget;
}

export function statusNotification(kind: StatusNotice, locale: Locale): StatusNotification {
  return {
    notification: {
      id: `status:${kind}`,
      title: t(locale, `status.${kind}.title`),
      body: t(locale, `status.${kind}.body`),
      href: null,
      urgency: kind === "online" ? "low" : "normal",
      silent: kind === "online",
    },
    target: kind === "expired" || kind === "revoked" ? "connect" : "cockpit",
  };
}

export function updateNotice(previous: UpdateState, next: UpdateState): string | null {
  if (next.phase !== "available") return null;
  if (
    (previous.phase === "available" || previous.phase === "downloading") &&
    previous.version === next.version
  )
    return null;
  return next.version;
}

export function updateNotification(version: string, locale: Locale): StatusNotification {
  return {
    notification: {
      id: `update:${version}`,
      title: t(locale, "status.update.title"),
      body: t(locale, "status.update.body", { version }),
      href: null,
      urgency: "low",
      silent: true,
    },
    target: "settings",
  };
}

export type BannerKind = "offline" | "expired" | "revoked" | "server-too-old";

export interface ShellBanner {
  kind: BannerKind;
  tone: "warning" | "danger";
  title: string;
  body: string;
  ask: string | null;
}

export interface ShellStatus {
  connection: Connection;
  banner: ShellBanner | null;
  update: { version: string; ready: boolean } | null;
}

export function shellBanner(
  connection: Connection,
  locale: Locale,
  tooOld: TooOldAsk | null,
): ShellBanner | null {
  if (connection === "offline")
    return {
      kind: "offline",
      tone: "warning",
      title: t(locale, "status.offline.title"),
      body: t(locale, "status.offline.body"),
      ask: null,
    };
  if (connection === "expired" || connection === "revoked")
    return {
      kind: connection,
      tone: "danger",
      title: t(locale, `status.${connection}.title`),
      body: t(locale, `status.${connection}.body`),
      ask: null,
    };
  if (tooOld) {
    const copy = tooOldCopyIn(tooOld, locale);
    return {
      kind: "server-too-old",
      tone: "warning",
      title: copy.title,
      body: copy.body,
      ask: copy.message,
    };
  }
  return null;
}

export function shellStatus(
  connection: Connection,
  update: UpdateState,
  locale: Locale,
  tooOld: TooOldAsk | null,
): ShellStatus {
  const pending =
    update.phase === "available" || update.phase === "downloading" || update.phase === "ready"
      ? { version: update.version, ready: update.phase === "ready" }
      : null;
  return { connection, banner: shellBanner(connection, locale, tooOld), update: pending };
}
