import { describe, expect, test } from "bun:test";
import { clientKindOf } from "@/features/feedback/model";
import { appDeviceState, runsInstalled } from "./display-mode";

const display = (mode: string | null, standalone?: boolean) => ({
  matchMedia: (query: string) => ({ matches: query === `(display-mode: ${mode})` }),
  navigator: standalone === undefined ? {} : { standalone },
});

describe("installed display mode", () => {
  test("an installed window counts in every installed display mode", () => {
    for (const mode of ["standalone", "window-controls-overlay", "minimal-ui"])
      expect(runsInstalled(display(mode)), mode).toBeTrue();
  });

  test("a browser tab does not, also in fullscreen", () => {
    expect(runsInstalled(display("browser"))).toBeFalse();
    expect(runsInstalled(display("fullscreen"))).toBeFalse();
    expect(runsInstalled(undefined)).toBeFalse();
    expect(runsInstalled({})).toBeFalse();
  });

  test("a home screen app on iOS counts without a display mode", () => {
    expect(runsInstalled(display(null, true))).toBeTrue();
    expect(runsInstalled(display(null, false))).toBeFalse();
  });

  test("the reported client kind follows it", () => {
    expect(clientKindOf({ desktop: false, standalone: runsInstalled(display("standalone")) })).toBe(
      "pwa",
    );
    expect(clientKindOf({ desktop: false, standalone: runsInstalled(display("browser")) })).toBe(
      "browser",
    );
    expect(clientKindOf({ desktop: true, standalone: true })).toBe("desktop");
  });
});

describe("the app state shown in settings", () => {
  const base = { installed: false, desktop: false, secure: true, notifications: false };

  test("a browser tab is not installed and can be installed over a secure origin", () => {
    expect(appDeviceState(base)).toEqual({
      installed: false,
      installable: true,
      notifications: false,
    });
    expect(appDeviceState({ ...base, secure: false }).installable).toBe(false);
  });

  test("an installed window or the desktop app counts as installed and offers no install", () => {
    expect(appDeviceState({ ...base, installed: true, notifications: true })).toEqual({
      installed: true,
      installable: false,
      notifications: true,
    });
    expect(appDeviceState({ ...base, desktop: true }).installed).toBe(true);
  });
});
