import { describe, expect, test } from "bun:test";
import {
  quickCaptureAccelerator,
  type TrayMenuItem,
  type TrayModel,
  trayImage,
  trayMenu,
  trayStatus,
  trayTitle,
  trayTooltip,
} from "./tray-model.ts";

const base: TrayModel = {
  locale: "de",
  count: 0,
  connection: "online",
  mute: null,
  update: null,
  quickCapture: "Alt+Space",
  launchAtLogin: { checked: true, enabled: true },
  liveView: false,
};

const at = (hour: number, minute: number) => new Date(2026, 10, 21, hour, minute, 0, 0);

const actions = (items: TrayMenuItem[]) =>
  items.map((item) => (item.kind === "separator" ? "-" : item.action));
const item = (items: TrayMenuItem[], action: string) =>
  items.find((entry) => entry.kind === "item" && entry.action === action) as Extract<
    TrayMenuItem,
    { kind: "item" }
  >;

describe("tray status and tooltip", () => {
  test("names the count while connected and the state otherwise", () => {
    expect(trayStatus({ ...base, count: 3 })).toBe("Braucht dich (3)");
    expect(trayStatus(base)).toBe("Nichts braucht dich gerade");
    expect(trayStatus({ ...base, connection: "offline", count: 3 })).toBe(
      "Keine Verbindung zum Server",
    );
    expect(trayStatus({ ...base, connection: "signed-out" })).toBe("Nicht angemeldet");
    expect(trayStatus({ ...base, connection: "revoked", locale: "en" })).toBe("Sign in again…");
  });

  test("the tooltip carries the app name, the status and until when banners are off", () => {
    expect(trayTooltip("SubKit", { ...base, count: 2 })).toBe("SubKit – Braucht dich (2)");
    expect(
      trayTooltip("SubKit Dev", {
        ...base,
        locale: "en",
        count: 1,
        mute: { reason: "paused", until: at(14, 30) },
      }),
    ).toBe("SubKit Dev – Needs you (1) · Paused until 02:30 PM");
  });

  test("the menu bar shows the count only while it is current", () => {
    expect(trayTitle({ connection: "online", count: 4 })).toBe("4");
    expect(trayTitle({ connection: "online", count: 0 })).toBe("");
    expect(trayTitle({ connection: "online", count: 250 })).toBe("99+");
    expect(trayTitle({ connection: "offline", count: 4 })).toBe("");
    expect(trayTitle({ connection: "expired", count: 4 })).toBe("");
  });
});

describe("tray menu", () => {
  test("follows the order of the click-dummy", () => {
    const menu = trayMenu({ ...base, update: { label: "Nach Updates suchen", enabled: true } });
    expect(actions(menu)).toEqual([
      "open",
      "needsYou",
      "-",
      "pause",
      "launchAtLogin",
      "update",
      "quickCapture",
      "-",
      "settings",
      "reportProblem",
      "quit",
    ]);
    expect(item(menu, "quickCapture")).toMatchObject({
      label: "Schnellnotiz …",
      accelerator: "Alt+Space",
      enabled: true,
    });
  });

  test("keeps “Launch at login” as a checkbox", () => {
    expect(item(trayMenu(base), "launchAtLogin")).toMatchObject({
      label: "Beim Anmelden starten",
      checked: true,
      enabled: true,
    });
  });

  test("“Needs you” carries the count and opens only while connected", () => {
    expect(item(trayMenu({ ...base, count: 5 }), "needsYou")).toMatchObject({
      label: "Braucht dich (5)",
      enabled: true,
    });
    expect(item(trayMenu({ ...base, connection: "offline" }), "needsYou").enabled).toBe(false);
    const approval = { kind: "payment" as const, href: "/settings?area=vault", count: 2 };
    expect(item(trayMenu({ ...base, approval }), "approval").label).toBe("Zahlung freigeben (2)");
    expect(trayMenu({ ...base, approval, connection: "offline" }).length).toBe(
      trayMenu({ ...base, connection: "offline" }).length,
    );
  });

  test("a pause turns into resume and names the time banners come back", () => {
    const menu = trayMenu({ ...base, mute: { reason: "paused", until: at(15, 5) } });
    expect(item(menu, "resume")).toMatchObject({
      label: "Benachrichtigungen fortsetzen",
      sublabel: "Pausiert bis 15:05 Uhr",
    });
    expect(item(menu, "pause")).toBeUndefined();
  });

  test("quiet hours keep the pause item and name their end", () => {
    const menu = trayMenu({ ...base, mute: { reason: "quiet-hours", until: at(7, 0) } });
    expect(item(menu, "pause")).toMatchObject({
      label: "Benachrichtigungen 1 Stunde pausieren",
      sublabel: "Ruhezeit bis 07:00 Uhr",
    });
  });

  test("a pause until resumed and open quiet hours name no time", () => {
    expect(
      item(trayMenu({ ...base, mute: { reason: "paused", until: null } }), "resume"),
    ).toMatchObject({
      sublabel: "Pausiert bis zum Fortsetzen",
    });
    expect(
      item(
        trayMenu({ ...base, locale: "en", mute: { reason: "quiet-hours", until: null } }),
        "pause",
      ).sublabel,
    ).toBe("Quiet hours");
  });

  test("without a signed-in server there is no quick note and no update item", () => {
    const menu = trayMenu({ ...base, connection: "signed-out", quickCapture: null });
    expect(actions(menu)).not.toContain("quickCapture");
    expect(actions(menu)).not.toContain("update");
  });

  test("a running live session offers its live view right below “Needs you”", () => {
    const items = trayMenu({ ...base, liveView: true });
    expect(items[2]).toEqual({
      kind: "item",
      action: "liveView",
      label: "Live-Ansicht öffnen",
      enabled: true,
    });
    expect(trayMenu(base).some((item) => item.kind === "item" && item.action === "liveView")).toBe(
      false,
    );
  });

  test("quick capture is disabled while offline", () => {
    expect(item(trayMenu({ ...base, connection: "offline" }), "quickCapture").enabled).toBe(false);
  });
});

describe("tray image and shortcut", () => {
  test("macOS gets the monochrome template, other systems the colour icon", () => {
    expect(trayImage("darwin")).toEqual({ file: "trayTemplate.png", template: true, size: 18 });
    expect(trayImage("win32")).toEqual({ file: "icon.png", template: false, size: 24 });
    expect(trayImage("linux").template).toBe(false);
  });

  test("⌥ Space on macOS, Ctrl+Alt+Space where Alt+Space opens the window menu", () => {
    expect(quickCaptureAccelerator("darwin")).toBe("Alt+Space");
    expect(quickCaptureAccelerator("win32")).toBe("Control+Alt+Space");
    expect(quickCaptureAccelerator("linux")).toBe("Control+Alt+Space");
  });
});
