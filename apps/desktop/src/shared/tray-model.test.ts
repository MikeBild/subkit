import { describe, expect, test } from "bun:test";
import { type TrayModel, trayImage, trayStatus, trayTitle, trayTooltip } from "./tray-model.ts";

const base: TrayModel = {
  locale: "de",
  count: 0,
  connection: "online",
  paused: false,
  launchAtLogin: false,
  update: null,
};

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

  test("the tooltip carries the app name, the status and a pause", () => {
    expect(trayTooltip("SubKit", { ...base, count: 2 })).toBe("SubKit – Braucht dich (2)");
    expect(trayTooltip("SubKit Dev", { ...base, locale: "en", count: 1, paused: true })).toBe(
      "SubKit Dev – Needs you (1) · Notifications paused",
    );
  });

  test("the menu bar shows the count only while it is current", () => {
    expect(trayTitle({ connection: "online", count: 4 })).toBe("4");
    expect(trayTitle({ connection: "online", count: 0 })).toBe("");
    expect(trayTitle({ connection: "online", count: 250 })).toBe("99+");
    expect(trayTitle({ connection: "offline", count: 4 })).toBe("");
    expect(trayTitle({ connection: "expired", count: 4 })).toBe("");
  });
});

describe("tray image", () => {
  test("macOS gets the monochrome template, other systems the colour icon", () => {
    expect(trayImage("darwin")).toEqual({ file: "trayTemplate.png", template: true, size: 18 });
    expect(trayImage("win32")).toEqual({ file: "icon.png", template: false, size: 24 });
    expect(trayImage("linux").template).toBe(false);
  });
});
