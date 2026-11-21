import { describe, expect, test } from "bun:test";
import { render } from "@/pages/settings-fixtures";
import { LaunchAtLoginRow, PrivacyPanel, UpdatesPanel } from "./desktop-settings";
import {
  type DesktopSettings,
  desktopSettingsBridgeOf,
  parseDesktopSettings,
} from "./desktop-settings-model";
import { StartLayoutRows } from "./start-layout-rows";

const settings: DesktopSettings = {
  appVersion: "11.2.0",
  launchAtLogin: true,
  launchAtLoginAvailable: true,
  shareDiagnostics: false,
  notifications: true,
  update: {
    line: "SubKit Desktop 11.2.0 ist aktuell.",
    progress: null,
    action: { label: "Nach Updates suchen", primary: false, enabled: true },
  },
};
const control = { settings, change: () => {}, runUpdate: () => {} };

describe("desktop settings from the bridge", () => {
  test("reads only known fields and clamps the progress", () => {
    expect(
      parseDesktopSettings({
        ...settings,
        token: "secret",
        update: { line: "x", progress: 140, action: null },
      }),
    ).toEqual({ ...settings, update: { line: "x", progress: 100, action: null } });
    expect(parseDesktopSettings(null)).toBeNull();
    expect(parseDesktopSettings({ notifications: false })?.notifications).toBe(false);
    expect(parseDesktopSettings({})?.notifications).toBe(true);
  });

  test("a web browser or an older desktop has no settings bridge", () => {
    expect(desktopSettingsBridgeOf(undefined)).toBeNull();
    expect(desktopSettingsBridgeOf({ diagnostics: () => null })).toBeNull();
    expect(
      desktopSettingsBridgeOf({
        desktopSettings: async () => settings,
        updateDesktopSettings: async () => {},
        runUpdateAction: async () => {},
      }),
    ).not.toBeNull();
  });
});

describe("desktop rows and areas", () => {
  test("open at login shows only where the system can do it", () => {
    expect(render(<LaunchAtLoginRow control={control} />)).toContain("Beim Anmelden öffnen");
    expect(render(<LaunchAtLoginRow control={null} />)).toBe("");
    expect(
      render(
        <LaunchAtLoginRow
          control={{ ...control, settings: { ...settings, launchAtLoginAvailable: false } }}
        />,
      ),
    ).toBe("");
  });

  test("updates show the version, the state and one action", () => {
    const html = render(<UpdatesPanel control={control} />);
    expect(html).toContain("11.2.0");
    expect(html).toContain("SubKit Desktop 11.2.0 ist aktuell.");
    expect(html).toContain('data-testid="settings-updates-action"');
  });

  test("privacy holds the diagnostics consent, off by default", () => {
    const html = render(<PrivacyPanel control={control} />);
    expect(html).toContain("Diagnosedaten an Fehlerberichte anhängen");
    expect(html).toMatch(
      /data-state="unchecked"[^>]*data-testid="settings-desktop-diagnostics-switch"/,
    );
  });

  test("the sidebars have their start switches", () => {
    const html = render(<StartLayoutRows />);
    expect(html).toContain("Linke Leiste eingeklappt starten");
    expect(html).toContain("Rechte Leiste offen starten");
  });
});
