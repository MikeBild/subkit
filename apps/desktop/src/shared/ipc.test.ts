import { describe, expect, test } from "bun:test";
import { clipboardText, desktopSettingsPatch, desktopUpdateView } from "./ipc.ts";

describe("settings the Cockpit may change", () => {
  test("only launch at login and diagnostics pass, with real booleans", () => {
    expect(
      desktopSettingsPatch({
        launchAtLogin: true,
        shareDiagnostics: false,
        notifications: false,
        locale: "de",
        notificationsAsked: true,
      }),
    ).toEqual({ launchAtLogin: true, shareDiagnostics: false, notifications: false });
    expect(desktopSettingsPatch({ launchAtLogin: "yes" })).toEqual({});
    expect(desktopSettingsPatch(null)).toEqual({});
  });
});

describe("the update line the Cockpit shows", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key;

  test("a ready update offers the restart, a running download shows its progress", () => {
    expect(desktopUpdateView({ phase: "ready", version: "11.3.0" }, "11.2.0", t)).toEqual({
      line: 'updates.state.ready {"version":"11.3.0"}',
      progress: null,
      action: { label: "updates.restart", primary: true, enabled: true },
    });
    const downloading = desktopUpdateView(
      { phase: "downloading", version: "11.3.0", percent: 40 },
      "11.2.0",
      t,
    );
    expect(downloading.progress).toBe(40);
    expect(downloading.action).toEqual({
      label: "tray.checkUpdates",
      primary: false,
      enabled: false,
    });
  });

  test("without updates there is no action", () => {
    expect(desktopUpdateView({ phase: "disabled" }, "11.2.0", t).action).toBeNull();
  });
});

describe("text the sign-in window may put on the clipboard", () => {
  test("only a bounded, non-empty string passes", () => {
    expect(clipboardText("Please update the server")).toBe("Please update the server");
    expect(clipboardText("x".repeat(2000))).toHaveLength(2000);
    expect(clipboardText("x".repeat(2001))).toBeNull();
    expect(clipboardText("")).toBeNull();
    expect(clipboardText(42)).toBeNull();
    expect(clipboardText(null)).toBeNull();
  });
});
