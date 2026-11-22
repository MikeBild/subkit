import { describe, expect, test } from "bun:test";
import { dictionary } from "../../shared/i18n.ts";
import { type ConnectState, LOCAL_UNAVAILABLE } from "../../shared/ipc.ts";
import { NO_ONBOARDING } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import { quietHoursPatch, settingsFor } from "./settings-model.ts";

function main(patch: Partial<ConnectState> = {}): ConnectState {
  return {
    appVersion: "11.2.0",
    deviceLabel: "MacBook-Anna",
    locale: "de",
    messages: dictionary("de"),
    view: "settings",
    profiles: [
      {
        id: "p1",
        label: "work",
        serverOrigin: "https://work.example.com",
        signedIn: true,
        active: true,
      },
      {
        id: "p2",
        label: "local",
        serverOrigin: "http://localhost:3000",
        signedIn: false,
        active: false,
      },
    ],
    settings: {
      locale: "system",
      launchAtLogin: true,
      quietHours: { enabled: true, start: "22:00", end: "07:00" },
      notifications: true,
      shareDiagnostics: false,
    },
    login: { phase: "idle" },
    notice: null,
    signedIn: null,
    onboarding: NO_ONBOARDING,
    update: { phase: "idle" },
    permissions: {
      supported: true,
      permissions: { accessibility: false, screen: false, restartPending: false },
      lost: [],
    },
    local: LOCAL_UNAVAILABLE,
    platform: platformCapabilities("darwin", "arm64"),
    ...patch,
  };
}

describe("settings model", () => {
  test("each known server appears once by host with the action that fits it", () => {
    expect(settingsFor(main()).servers).toEqual([
      {
        profileId: "p1",
        host: "work.example.com",
        active: true,
        primary: { label: "profiles.open", command: "open" },
      },
      {
        profileId: "p2",
        host: "localhost:3000",
        active: false,
        primary: { label: "profiles.signIn", command: "sign-in" },
      },
    ]);
  });

  test("the switches mirror the saved settings", () => {
    const model = settingsFor(main());
    expect(model.launchAtLogin).toBe(true);
    expect(model.quietHours).toEqual({ enabled: true, start: "22:00", end: "07:00" });
    expect(model.locale).toBe("system");
  });

  test("updates off in this build show the status without a button", () => {
    const { update } = settingsFor(main({ update: { phase: "disabled" } }));
    expect(update.status.key).toBe("updates.disabled");
    expect(update.action).toBeNull();
  });

  test("a loading update shows its progress and a busy button", () => {
    const { update } = settingsFor(
      main({ update: { phase: "downloading", version: "11.3.0", percent: 40 } }),
    );
    expect(update.progress).toBe(40);
    expect(update.action).toEqual({ label: "tray.checkUpdates", enabled: false, primary: false });
  });

  test("a loaded update offers the restart as the primary action", () => {
    const { update } = settingsFor(main({ update: { phase: "ready", version: "11.3.0" } }));
    expect(update.action).toEqual({ label: "updates.restart", enabled: true, primary: true });
    expect(update.progress).toBeNull();
  });

  test("quiet hours change only with both times present", () => {
    const current = { enabled: true, start: "22:00", end: "07:00" };
    expect(quietHoursPatch(current, { enabled: false })).toEqual({ ...current, enabled: false });
    expect(quietHoursPatch(current, { start: "" })).toBeNull();
  });
});
