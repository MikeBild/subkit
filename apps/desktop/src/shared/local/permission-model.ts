export const PERMISSION_KEYS = ["accessibility", "screen"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type MediaAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface PermissionProbe {
  accessibility: boolean;
  screen: MediaAccess;
}

export interface Permissions {
  accessibility: boolean;
  screen: boolean;
  restartPending: boolean;
}

export const NO_PERMISSIONS: Permissions = {
  accessibility: false,
  screen: false,
  restartPending: false,
};

export const SETTINGS_URLS: Record<PermissionKey, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export function isPermissionKey(value: unknown): value is PermissionKey {
  return value === "accessibility" || value === "screen";
}

export function permissionsFrom(probe: PermissionProbe, atLaunch: PermissionProbe): Permissions {
  const screen = probe.screen === "granted";
  return {
    accessibility: probe.accessibility,
    screen,
    restartPending: screen && atLaunch.screen !== "granted",
  };
}

export function permissionGranted(permissions: Permissions, key: PermissionKey): boolean {
  return permissions[key] && (key !== "screen" || !permissions.restartPending);
}

export function permissionsDone(permissions: Permissions): boolean {
  return PERMISSION_KEYS.every((key) => permissionGranted(permissions, key));
}

export function trackLost(
  lost: readonly PermissionKey[],
  before: Permissions,
  after: Permissions,
): PermissionKey[] {
  return PERMISSION_KEYS.filter((key) => !after[key] && (before[key] || lost.includes(key)));
}

export function samePermissions(a: Permissions, b: Permissions): boolean {
  return (
    a.accessibility === b.accessibility &&
    a.screen === b.screen &&
    a.restartPending === b.restartPending
  );
}
