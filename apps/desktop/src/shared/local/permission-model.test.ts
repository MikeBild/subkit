import { describe, expect, test } from "bun:test";
import {
  isPermissionKey,
  type MediaAccess,
  NO_PERMISSIONS,
  type PermissionProbe,
  type Permissions,
  permissionGranted,
  permissionsDone,
  permissionsFrom,
  SETTINGS_URLS,
  samePermissions,
  trackLost,
} from "./permission-model.ts";

const probe = (accessibility: boolean, screen: MediaAccess): PermissionProbe => ({
  accessibility,
  screen,
});
const all: Permissions = { accessibility: true, screen: true, restartPending: false };

describe("permissionsFrom", () => {
  test("only a granted screen status counts as granted", () => {
    for (const screen of ["not-determined", "denied", "restricted", "unknown"] as const)
      expect(permissionsFrom(probe(false, screen), probe(false, screen))).toEqual(NO_PERMISSIONS);
    expect(permissionsFrom(probe(true, "granted"), probe(true, "granted"))).toEqual(all);
  });

  test("Screen Recording granted after launch needs a restart", () => {
    expect(permissionsFrom(probe(false, "granted"), probe(false, "denied"))).toEqual({
      accessibility: false,
      screen: true,
      restartPending: true,
    });
    expect(permissionsFrom(probe(false, "denied"), probe(false, "denied")).restartPending).toBe(
      false,
    );
  });
});

describe("granted and done", () => {
  test("Screen Recording counts only after the restart", () => {
    const pending = { ...all, restartPending: true };
    expect(permissionGranted(pending, "screen")).toBe(false);
    expect(permissionGranted(pending, "accessibility")).toBe(true);
    expect(permissionGranted(all, "screen")).toBe(true);
    expect(permissionGranted(NO_PERMISSIONS, "accessibility")).toBe(false);
    expect(permissionGranted({ ...NO_PERMISSIONS, accessibility: true }, "screen")).toBe(false);
  });

  test("setup is done when both are granted and no restart is pending", () => {
    expect(permissionsDone(all)).toBe(true);
    expect(permissionsDone({ ...all, restartPending: true })).toBe(false);
    expect(permissionsDone({ ...all, accessibility: false })).toBe(false);
    expect(permissionsDone({ ...all, screen: false })).toBe(false);
  });
});

describe("changes", () => {
  test("names each permission that went missing and keeps it until it is back", () => {
    expect(trackLost([], all, NO_PERMISSIONS)).toEqual(["accessibility", "screen"]);
    expect(trackLost([], all, { ...all, screen: false })).toEqual(["screen"]);
    expect(trackLost([], NO_PERMISSIONS, all)).toEqual([]);
    expect(trackLost([], NO_PERMISSIONS, NO_PERMISSIONS)).toEqual([]);
    expect(trackLost(["screen"], NO_PERMISSIONS, NO_PERMISSIONS)).toEqual(["screen"]);
    expect(trackLost(["screen"], NO_PERMISSIONS, { ...NO_PERMISSIONS, screen: true })).toEqual([]);
  });

  test("compares every field", () => {
    expect(samePermissions(all, { ...all })).toBe(true);
    expect(samePermissions(all, { ...all, accessibility: false })).toBe(false);
    expect(samePermissions(all, { ...all, screen: false })).toBe(false);
    expect(samePermissions(all, { ...all, restartPending: true })).toBe(false);
  });
});

describe("settings links", () => {
  test("open the privacy panes and only known keys pass", () => {
    expect(SETTINGS_URLS).toEqual({
      accessibility:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    });
    expect(isPermissionKey("accessibility")).toBe(true);
    expect(isPermissionKey("screen")).toBe(true);
    expect(isPermissionKey("camera")).toBe(false);
    expect(isPermissionKey(undefined)).toBe(false);
  });
});
